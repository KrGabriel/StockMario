export type MaterialType = "consumable" | "reusable";
export type MovementType = "withdrawal" | "return";

export interface Technician {
  id: string;
  full_name: string;
  active: boolean;
  created_at: string;
}

export interface Material {
  id: string;
  code: string;
  name: string;
  category: string | null;
  material_type: MaterialType;
  unit: string;
  initial_stock: number;
  minimum_stock: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MaterialStock extends MaterialRowFields {
  total_withdrawn: number;
  total_returned: number;
  current_stock: number;
  is_low_stock: boolean | null;
  is_out_of_stock: boolean | null;
}

interface MaterialRowFields {
  id: string;
  code: string;
  name: string;
  category: string | null;
  material_type: MaterialType;
  unit: string;
  minimum_stock: number;
  active: boolean;
  initial_stock: number;
}

export interface Movement {
  id: string;
  technician_id: string;
  material_id: string;
  movement_type: MovementType;
  quantity: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  idempotency_key: string | null;
}

export interface PendingWithdrawal {
  id: string;
  technician_id: string;
  technician_name: string;
  material_id: string;
  material_name: string;
  material_code: string;
  material_category: string | null;
  withdrawn_qty: number;
  returned_qty: number;
  pending_qty: number;
  withdrawn_at: string;
}

export interface AllocationInput {
  withdrawal_movement_id: string;
  quantity: number;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL: string;
    readonly VITE_SUPABASE_ANON_KEY: string;
  }
}
