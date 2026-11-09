// Syntax normalization only. Provider numbering-plan validation and country routing
// happen separately. A national number must never silently inherit a country.
export function normaliseInternationalPhone(value: string): string {
  if (value.length > 40 || !/^\+[0-9 ()-]+$/.test(value.trim())) throw new Error("Use an international phone number starting with + and its country code");
  const phone = value.trim().replace(/[ ()-]/g, "");
  if (!/^\+[1-9][0-9]{3,14}$/.test(phone)) throw new Error("Use an international phone number starting with + and its country code");
  return phone;
}
