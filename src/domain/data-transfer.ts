import { z } from "zod";

const highTierType = z.enum(["date_of_birth", "passport", "driver_licence", "car_registration", "custom"]);
const label = z.string().min(1).max(200);
const reference = z.string().min(1).max(200);
// A card's billing address (docs/adr/card-billing-addresses.md) is one of the person's About you
// postal addresses (`billingAddressId`, an identity field id in the export), an address kept with
// their cards only (`billingEntryId`, an id in `profile.cardBillingAddresses`) or none yet. Both
// are optional so older exports (postal references only) and cards with no address still import.
const cardMetadata = {
  brand: label,
  lastFour: z.string().regex(/^\d{4}$/),
  nickname: z.string().max(200),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(9999),
  cardholderName: z.string().max(200).nullable().optional(),
  billingAddressId: reference.optional(),
  billingEntryId: reference.optional(),
};
// A card has one billing address, never both kinds of reference.
const oneBillingReference = (card: { billingAddressId?: string; billingEntryId?: string }) =>
  card.billingAddressId === undefined || card.billingEntryId === undefined;
const oneBillingMessage = { message: "A card has one billing address, not both kinds of reference" };
// Encrypted values must be complete versioned AES-GCM envelopes, never raw values.
const ciphertext = z.string().max(100_000).regex(/^v1:[A-Za-z0-9+/]{38,}={0,2}$/);
export const sealedVaultSchema = z.strictObject({
  highTierFields: z.array(z.strictObject({ type: highTierType, label, ciphertext })).max(1000),
  cards: z.array(z.strictObject({ ...cardMetadata, numberCiphertext: ciphertext }).refine(oneBillingReference, oneBillingMessage)).max(1000),
});
export const plaintextVaultSchema = z.strictObject({
  highTierFields: z.array(z.strictObject({ type: highTierType, label, value: z.string().max(50_000) })).max(1000),
  cards: z.array(z.strictObject({ ...cardMetadata, number: z.string().regex(/^\d{12,19}$/) }).refine(oneBillingReference, oneBillingMessage)).max(1000),
});
export type SealedVault = z.infer<typeof sealedVaultSchema>;

// An export's `profile.cardBillingAddresses`: the person's card-only billing addresses. The
// device export carries each one's id so a card's `billingEntryId` can be re-linked on import;
// the plain export carries the values alone. Optional, so older exports stay valid.
export const cardBillingAddressesSchema = z.array(z.strictObject({
  id: reference.optional(),
  value: z.string().trim().min(1).max(4096),
})).max(1000);
export type CardBillingAddressesDoc = z.infer<typeof cardBillingAddressesSchema>;
