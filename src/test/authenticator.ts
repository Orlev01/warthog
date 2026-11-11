// Software passkey authenticator for tests (design §5, §4.2).
//
// A stateful stand-in for a browser + platform authenticator that produces REAL
// WebAuthn attestation and assertion objects — including a PRF result — that the
// production `@simplewebauthn/server` verifiers accept. It lets a passkey
// registration AND authentication be driven end to end in a test with no browser,
// no Azure and no network: the only non-test code involved is the real server
// library doing the verifying.
//
// The authenticator remembers every credential it registers (keypair, PRF secret,
// signature counter and user handle), so a credential registered through
// `register()` is the one `authenticate()` later signs with.
//
// Crypto is real: ES256 (ECDSA P-256) keys via Node's crypto, signatures in the
// ASN.1/DER form WebAuthn uses, and HMAC-SHA256 for the PRF — the same primitives a
// hardware authenticator uses, so a tampered response genuinely fails to verify.

import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as signWithKey,
  type KeyObject,
} from "node:crypto";

import { cose, isoBase64URL, isoCBOR, isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationExtensionsClientInputs,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

// The value shape the CBOR encoder accepts, borrowed from the real encoder's own
// signature so the maps we build are exactly what it serialises (CBOR maps, byte
// strings and integers) without naming its transitive dependency.
type CborValue = Parameters<typeof isoCBOR.encode>[0];

// Authenticator-data flag bits (WebAuthn §6.1). residentKey + userVerification are
// "required" in these flows, so every response asserts user presence and user
// verification; attestation additionally carries attested credential data.
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

// "none" attestation carries an all-zero AAGUID (WebAuthn §6.5.1).
const AAGUID = new Uint8Array(16);

// WebAuthn PRF context prefix: "WebAuthn PRF" followed by a 0x00 byte. The PRF input
// (the eval salt) is hashed together with this prefix before the per-credential HMAC,
// exactly as a CTAP2 hmac-secret authenticator derives its output.
const PRF_PREFIX = utf8("WebAuthn PRF\u0000");

/** The seam the tests drive: a software authenticator with two intent-named ops. */
export interface SoftwareAuthenticator {
  register(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  authenticate(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
}

// One discoverable (resident) credential the authenticator holds.
interface StoredCredential {
  id: string;
  privateKey: KeyObject;
  prfSecret: Uint8Array<ArrayBuffer>;
  userHandle: string;
  signCount: number;
}

/**
 * Create a fresh software authenticator. Each instance holds its own credentials, so
 * two instances model two separate devices (and therefore two separate PRF secrets).
 * `origin` is the page origin the browser reports in clientDataJSON; it defaults to
 * `https://<rpId>` but a real deployment's origin need not be (dev is
 * `http://localhost:3000`, and an app on a subdomain of the RP ID differs from it).
 */
export function createAuthenticator(opts: { origin?: string } = {}): SoftwareAuthenticator {
  const originFor = (rpId: string) => opts.origin ?? `https://${rpId}`;
  const credentials = new Map<string, StoredCredential>();

  async function register(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): Promise<RegistrationResponseJSON> {
    const rpId = requireRpId(options.rp.id);

    // A real ES256 (P-256) keypair; the public key becomes the credential's COSE key.
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { x, y } = exportEC2Coordinates(publicKey);
    const coseKeyBytes = isoCBOR.encode(ec2CoseKey(x, y));

    const credentialIdBytes = new Uint8Array(randomBytes(32));
    const credentialId = isoBase64URL.fromBuffer(credentialIdBytes);
    const prfSecret = new Uint8Array(randomBytes(32));

    const authData = isoUint8Array.concat([
      rpIdHash(rpId),
      Uint8Array.of(FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_CREDENTIAL_DATA),
      uint32BE(0),
      AAGUID,
      uint16BE(credentialIdBytes.length),
      credentialIdBytes,
      coseKeyBytes,
    ]);

    // "none" attestation: fmt "none" with an empty attestation statement (the
    // verifier rejects any statement bytes under "none").
    const attestationObject = isoCBOR.encode(
      new Map<string | number, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map<string | number, CborValue>()],
        ["authData", authData],
      ]),
    );

    credentials.set(credentialId, {
      id: credentialId,
      privateKey,
      prfSecret,
      userHandle: options.user.id,
      signCount: 0,
    });

    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: encodeClientDataJSON("webauthn.create", options.challenge, originFor(rpId)),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
      // Many authenticators only report `enabled` on create (the PRF output itself is
      // produced on get); surface that acknowledgement when PRF was requested.
      clientExtensionResults: wantsPRF(options.extensions) ? { prf: { enabled: true } } : {},
    };
  }

  async function authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<AuthenticationResponseJSON> {
    const rpId = requireRpId(options.rpId);
    const credential = selectCredential(credentials, options.allowCredentials);

    credential.signCount += 1;
    const authData = isoUint8Array.concat([
      rpIdHash(rpId),
      Uint8Array.of(FLAG_USER_PRESENT | FLAG_USER_VERIFIED),
      uint32BE(credential.signCount),
    ]);

    const clientDataJSON = clientDataJSONBytes("webauthn.get", options.challenge, originFor(rpId));
    const signatureBase = isoUint8Array.concat([authData, sha256(clientDataJSON)]);
    // Node signs ECDSA/P-256 in ASN.1 DER by default — the wire form WebAuthn uses.
    const signature = new Uint8Array(signWithKey("sha256", signatureBase, credential.privateKey));

    const prf = evaluatePRF(credential.prfSecret, options.extensions);

    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(signature),
        // Discoverable (resident) credential: hand back the user handle it was
        // registered with.
        userHandle: credential.userHandle,
      },
      clientExtensionResults: prf ? { prf: { results: prf } } : {},
    };
  }

  return { register, authenticate };
}

// --- helpers -----------------------------------------------------------------------

// Pick the credential an assertion is for: the first match from `allowCredentials`
// if the relying party named any, otherwise the sole discoverable credential.
function selectCredential(
  credentials: Map<string, StoredCredential>,
  allowCredentials: PublicKeyCredentialDescriptorJSON[] | undefined,
): StoredCredential {
  if (allowCredentials && allowCredentials.length > 0) {
    for (const descriptor of allowCredentials) {
      const match = credentials.get(descriptor.id);
      if (match) return match;
    }
    throw new Error("authenticator holds no credential matching allowCredentials");
  }
  const all = [...credentials.values()];
  const only = all[all.length - 1];
  if (!only) throw new Error("authenticator has no registered credential");
  return only;
}

// Build the COSE_Key for an EC2/P-256/ES256 public key from its raw coordinates.
function ec2CoseKey(x: Uint8Array<ArrayBuffer>, y: Uint8Array<ArrayBuffer>): CborValue {
  return new Map<string | number, CborValue>([
    [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
    [cose.COSEKEYS.alg, cose.COSEALG.ES256],
    [cose.COSEKEYS.crv, cose.COSECRV.P256],
    [cose.COSEKEYS.x, x],
    [cose.COSEKEYS.y, y],
  ]);
}

// Read the 32-byte X and Y coordinates of a P-256 public key out of its JWK form.
function exportEC2Coordinates(publicKey: KeyObject): { x: Uint8Array<ArrayBuffer>; y: Uint8Array<ArrayBuffer> } {
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("EC public key is missing its coordinates");
  return {
    x: isoBase64URL.toBuffer(jwk.x, "base64url"),
    y: isoBase64URL.toBuffer(jwk.y, "base64url"),
  };
}

// Whether the request asked for a PRF evaluation.
function wantsPRF(extensions: AuthenticationExtensionsClientInputs | undefined): boolean {
  return extensions?.prf != null;
}

// Produce the PRF output(s) requested, or null if PRF was not asked for. The result is
// deterministic in (this credential's secret, salt): HMAC-SHA256(prfSecret, H(prefix ‖
// salt)). A different salt or a different credential yields a different 32-byte output.
function evaluatePRF(
  prfSecret: Uint8Array<ArrayBuffer>,
  extensions: AuthenticationExtensionsClientInputs | undefined,
): { first: Uint8Array<ArrayBuffer>; second?: Uint8Array<ArrayBuffer> } | null {
  const evalInputs = extensions?.prf?.eval;
  if (!evalInputs) return null;
  const first = derivePRF(prfSecret, toBytes(evalInputs.first));
  if (evalInputs.second != null) {
    return { first, second: derivePRF(prfSecret, toBytes(evalInputs.second)) };
  }
  return { first };
}

function derivePRF(prfSecret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const hashedInput = sha256(isoUint8Array.concat([PRF_PREFIX, salt]));
  return new Uint8Array(createHmac("sha256", prfSecret).update(hashedInput).digest());
}

// The clientDataJSON a browser would hand the authenticator, as base64url for the wire.
function encodeClientDataJSON(type: string, challenge: string, origin: string): string {
  return isoBase64URL.fromBuffer(clientDataJSONBytes(type, challenge, origin));
}

function clientDataJSONBytes(type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> {
  return utf8(
    JSON.stringify({
      type,
      challenge, // already base64url, exactly as the options carried it
      origin,
      crossOrigin: false,
    }),
  );
}

function rpIdHash(rpId: string): Uint8Array<ArrayBuffer> {
  return sha256(utf8(rpId));
}

function sha256(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function uint16BE(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function uint32BE(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function toBytes(source: ArrayBuffer | ArrayBufferView<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  // The WebAuthn library accepts arbitrary views, including SharedArrayBuffer.
  // Copy exactly the view's bytes into an owned ArrayBuffer for its crypto helpers.
  return new Uint8Array(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
}

function requireRpId(rpId: string | undefined): string {
  if (!rpId) throw new Error("WebAuthn options are missing an RP ID");
  return rpId;
}
