// Where a member sees and answers pending "approve from another device" sign-in requests
// (follow-up S3). A plain constant in its own module so client components can link here
// without importing the server-side request store.
export const SIGN_IN_REQUESTS_PATH = "/settings/security/sign-in-requests";
