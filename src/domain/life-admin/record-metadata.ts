import { z } from "zod";

export const MAX_REMINDER_OFFSET_DAYS = 36_500;

// Postgres dates have no year zero. ISO syntax alone accepts 0000, which would
// otherwise fail at the database boundary after the rest of the input is accepted.
export const recordDueDateSchema = z.iso.date().refine(date => !date.startsWith("0000-"));
export const reminderOffsetsSchema = z.array(z.number().int().min(0).max(MAX_REMINDER_OFFSET_DAYS)).max(50);
