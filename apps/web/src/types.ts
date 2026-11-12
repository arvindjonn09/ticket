export type {
  SessionView,
  TicketSummary,
  TicketDetail,
} from "@astrama/contracts";

export type Catalog = {
  categories: {
    id: string;
    name: string;
    departmentId: string;
    departmentName: string;
    allowIncidents?: boolean;
    allowRequests?: boolean;
    subcategories: {
      id: string;
      name: string;
      departmentId: string | null;
      departmentName: string;
    }[];
  }[];
  departments: { id: string; name: string }[];
  agents?: { id: string; name: string }[];
};
