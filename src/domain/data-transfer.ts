import { z } from "zod";

const highTierType = z.enum(["date_of_birth", "passport", "driver_licence", "car_registration", "custom"]);
const label = z.string().min(1).max(200);
const cardMetadata = {
  brand: label,
  lastFour: z.string().regex(/^\d{4}$/),
  nickname: z.string().max(200),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(9999),
  cardholderName: z.string().max(200).nullable().optional(),
  billingAddressId: z.string().min(1).max(200),
};
// Encrypted values must be complete versioned AES-GCM envelopes, never raw values.
const ciphertext = z.string().max(100_000).regex(/^v1:[A-Za-z0-9+/]{38,}={0,2}$/);
export const sealedVaultSchema = z.strictObject({
  highTierFields: z.array(z.strictObject({ type: highTierType, label, ciphertext })).max(1000),
  cards: z.array(z.strictObject({ ...cardMetadata, numberCiphertext: ciphertext })).max(1000),
});
export const plaintextVaultSchema = z.strictObject({
  highTierFields: z.array(z.strictObject({ type: highTierType, label, value: z.string().max(50_000) })).max(1000),
  cards: z.array(z.strictObject({ ...cardMetadata, number: z.string().regex(/^\d{12,19}$/) })).max(1000),
});
export type SealedVault = z.infer<typeof sealedVaultSchema>;
