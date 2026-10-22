/** Deterministic synthetic catalogue (120 products) for the test storefront used by kits 9 and 10. */

export interface Product {
  sku: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  rating: number;
  shipsInDays: number;
  returnsAccepted: boolean;
  description: string;
}

const FAMILIES: { category: string; items: [string, number][]; words: string[] }[] = [
  { category: "Tents", items: [["2-Person Backpacking Tent", 229], ["3-Person Dome Tent", 189], ["Ultralight Trekking Pole Tent", 289], ["Family Cabin Tent", 349], ["Bivy Shelter", 119]], words: ["Ridgeline", "Summit", "Alder", "Cirrus"] },
  { category: "Sleeping", items: [["Down Sleeping Bag 20°F", 199], ["Synthetic Sleeping Bag 30°F", 99], ["Insulated Sleeping Pad", 129], ["Camp Pillow", 29], ["Quilt 40°F", 159]], words: ["Ember", "Drift", "Hearth", "Nimbus"] },
  { category: "Hydration", items: [["Insulated Water Bottle Set (2 × 32 oz)", 74.51], ["Insulated Water Bottle 24 oz", 34], ["Gravity Water Filter", 89], ["Collapsible Bottle", 19], ["Hydration Reservoir 3L", 39]], words: ["Glacier", "Brook", "Tarn", "Rill"] },
  { category: "Kitchen", items: [["Titanium Cook Pot", 59], ["Canister Stove", 69], ["Camp Mug", 22], ["Spork Set", 14], ["Hanging Food Bag", 35]], words: ["Hearth", "Kindle", "Forge", "Cinder"] },
  { category: "Packs", items: [["55L Backpacking Pack", 249], ["Daypack 24L", 99], ["Hip Pack", 45], ["Pack Rain Cover", 29], ["Compression Sacks (3)", 39]], words: ["Granite", "Talus", "Scree", "Basalt"] },
  { category: "Lighting", items: [["Rechargeable Headlamp", 49], ["Camp Lantern", 39], ["String Lights", 25], ["Solar Charger 20W", 89], ["Power Bank 20,000 mAh", 59]], words: ["Lumen", "Halo", "Beacon", "Flare"] },
];

/** Small deterministic PRNG so the catalogue is identical on every run. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export function buildCatalog(): Product[] {
  const rand = rng(42);
  const out: Product[] = [];
  let n = 1000;
  for (const fam of FAMILIES) {
    for (const [base, price] of fam.items) {
      for (const word of fam.words) {
        const variance = word === fam.words[0] ? 0 : Math.round((rand() * 0.3 - 0.1) * price);
        out.push({
          sku: `TRL-${n++}`,
          name: `${word} ${base}`,
          category: fam.category,
          price: Math.round((price + variance) * 100) / 100,
          stock: Math.floor(rand() * 40) + (word === fam.words[3] ? 0 : 3),
          rating: Math.round((3.6 + rand() * 1.4) * 10) / 10,
          shipsInDays: 1 + Math.floor(rand() * 6),
          returnsAccepted: rand() > 0.15,
          description: `${word} ${base.toLowerCase()} from the Trailhead Outfitters range.`,
        });
      }
    }
  }
  return out; // 6 families × 5 items × 4 variants = 120 products
}

export function searchProducts(catalog: Product[], q: string, f: { maxPrice?: number; shipsWithinDays?: number; inStockOnly?: boolean; returnsRequired?: boolean } = {}) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  return catalog
    .map((p) => ({ p, score: terms.filter((t) => `${p.name} ${p.category}`.toLowerCase().includes(t)).length }))
    .filter(({ p, score }) => score > 0 && (f.maxPrice === undefined || p.price <= f.maxPrice) && (f.shipsWithinDays === undefined || p.shipsInDays <= f.shipsWithinDays) && (!f.inStockOnly || p.stock > 0) && (!f.returnsRequired || p.returnsAccepted))
    .sort((a, b) => b.score - a.score || b.p.rating - a.p.rating || a.p.price - b.p.price)
    .map(({ p }) => p);
}
