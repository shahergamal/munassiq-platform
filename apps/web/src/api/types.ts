// Response shapes of /api/v1 used by the UI (mirrors apps/api routes).

export interface MeTenant {
  id: string;
  companyName: string;
  sector: string;
  status: string;
  role: string;
  roleName: string | null;
  subscriptionStatus: string | null;
  endsAt: string | null;
  operational: boolean;
}

export interface Me {
  user: { id: string; email: string; fullName: string; emailVerified: boolean; isPlatformAdmin: boolean };
  tenants: MeTenant[];
  csrfToken: string;
}

export type { Permission } from "./permissions";
import type { Permission } from "./permissions";

export interface TenantContext {
  tenant: { id: string; companyName: string; sector: string; taxId: string; taxIdVerified: boolean; city: string | null; status: string };
  role: string;
  roleName: string | null;
  permissions: Permission[];
  readOnlySupport: boolean;
  supportSession: { id: string; expiresAt: string } | null;
  operational: boolean;
  subscription: { status: string | null; endsAt: string | null; planName: string | null };
  limits: { branches: { used: number; limit: number | null }; users: { used: number; limit: number | null }; storage?: { usedMb: number; limitMb: number | null } };
  settings: { vatRatePercent: number; discountApprovalPercent: number; poOwnerApprovalAbove?: number | null };
}

export interface Unit { id: string; code: string; name: string; dimension: "mass" | "volume" | "count"; toBase: number }

export interface Ingredient {
  id: string; sku: string; name: string; category: string | null; barcode: string | null; isActive: boolean;
  baseUnitId: string; baseUnit: string; baseUnitName: string; purchaseUnitId: string; purchaseUnitName: string;
  purchaseToBase: number; yieldPercentage: number; minStock: number; parStock?: number; trackExpiry?: boolean; shelfLifeDays?: number | null; stockQty: number; avgCost: number; baseUnitCode?: string;
  itemType?: ItemType; nameEn?: string | null; salePrice?: number | null; leadTimeDays?: number;
}
export type ItemType = "raw" | "semi_finished" | "finished" | "packaging" | "consumable" | "spare_part";

export interface Supplier { id: string; code: string; name: string; taxId: string | null; phone: string | null; email: string | null; paymentTermsDays: number; residency?: "resident" | "non_resident"; isActive: boolean }
export interface Branch { id: string; code: string; name: string; city: string | null; isActive: boolean }
export interface Location { id: string; code: string; name: string; branchId: string | null; locationType: "kitchen" | "warehouse" | "store" | "quarantine"; isActive: boolean }

/** A customer, with the business fields a standard (B2B) tax invoice needs for its buyer block. */
export interface Customer {
  id: string; name: string; phone: string; email: string | null; address: string | null; notes: string | null;
  ordersCount: number; totalSpent: number; lastOrderAt: string | null;
  customerType?: "individual" | "business"; vatNumber?: string | null; otherIdScheme?: string | null; otherId?: string | null;
  street?: string | null; buildingNo?: string | null; additionalNo?: string | null; district?: string | null; city?: string | null;
  postalCode?: string | null; countryCode?: string | null; paymentTermsDays?: number | null; creditLimit?: number | null; priceListId?: string | null;
}
