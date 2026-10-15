/** The operating business every kit acts for. All kits use this one profile. */
export const BUSINESS = {
  name: "Trailhead Outfitters LLC",
  tradingName: "Trailhead Outfitters",
  country: "US",
  countryName: "United States of America",
  baseCurrency: "USD",
  address: { street_address: "500 Market St", city: "San Francisco", state: "CA", postcode: "94105", country_code: "US" },
  storeUrl: "https://trailhead.example.com",
  procurementEmail: "procurement@trailhead.example.com",
} as const;
