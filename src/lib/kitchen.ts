export const INVENTORY_CATEGORIES = ["Grains", "Pulses", "Vegetables", "Cooking Oil"] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];
