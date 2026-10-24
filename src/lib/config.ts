/** Frontend origins allowed by CORS, from the comma-separated FRONTEND_URL. */
export function frontendOrigins() {
  return (process.env["FRONTEND_URL"] || "http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Where users land after sign-in: the first FRONTEND_URL entry. */
export function frontendUrl() {
  return frontendOrigins()[0] ?? "http://localhost:8080";
}
