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
  photo_path: string | null;
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

export type ReturnRequestStatus = "pending" | "approved" | "rejected";

export interface ReturnRequest {
  id: string;
  technician_id: string;
  material_id: string;
  quantity: number;
  notes: string | null;
  status: ReturnRequestStatus;
  allocations: { withdrawal_movement_id: string; quantity: number }[] | null;
  requested_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  admin_notes: string | null;
  movement_id: string | null;
  idempotency_key: string | null;
  technicians?: { full_name: string } | null;
  materials?: { name: string; code: string; unit: string } | null;
  profiles?: { email: string } | null;
}

/** Fila combinada de v_return_flow: movimientos de devolución (%) y solicitudes */
export interface ReturnFlowRow {
  id: string;
  source: "movement" | "request";
  technician_id: string;
  technician_name: string;
  material_id: string;
  material_name: string;
  material_code: string;
  unit: string;
  quantity: number;
  notes: string | null;
  requested_at: string;
  status: ReturnRequestStatus;
  resolved_by: string | null;
  resolver_email: string | null;
  resolved_at: string | null;
  admin_notes: string | null;
  photo_path: string | null;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL: string;
    readonly VITE_SUPABASE_ANON_KEY: string;
  }
}
