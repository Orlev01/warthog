import type { Db } from "../db/index";
import type { SealedVault } from "../../domain/data-transfer";

// Only opaque ciphertext and non-secret display metadata leave this boundary.
//
// A card's billing reference is a postal identity field id (billingAddressId) OR a card-only
// address id (billingEntryId; docs/adr/card-billing-addresses.md) or none yet. Each is emitted
// only when set, so a card with no billing address carries neither (never the text "null").
export async function exportProtectedVault(db: Db, userId: string): Promise<SealedVault> {
  const fields = await db.query("SELECT type, label, ciphertext FROM high_tier_fields WHERE user_id = $1", [userId]);
  const cards = await db.query("SELECT brand, last_four, expiry_month, expiry_year, nickname, cardholder_name, billing_address_id, billing_entry_id, number_ciphertext FROM cards WHERE user_id = $1", [userId]);
  return {
    highTierFields: fields.rows.map((row) => ({ type: row.type as SealedVault["highTierFields"][number]["type"], label: String(row.label), ciphertext: String(row.ciphertext) })),
    cards: cards.rows.map((row) => ({
      brand: String(row.brand), lastFour: String(row.last_four), expiryMonth: Number(row.expiry_month), expiryYear: Number(row.expiry_year), nickname: String(row.nickname), cardholderName: row.cardholder_name as string | null,
      ...(row.billing_address_id != null ? { billingAddressId: String(row.billing_address_id) } : {}),
      ...(row.billing_entry_id != null ? { billingEntryId: String(row.billing_entry_id) } : {}),
      numberCiphertext: String(row.number_ciphertext),
    })),
  };
}
