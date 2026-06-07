export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
export const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";

export const PORTFOLIOS = {
  advancedIndustrials: {
    key: "advanced_industrials_automation",
    name: "Advanced Industrials and Automation Portfolio",
  },
  enterpriseSoftware: {
    key: "enterprise_software",
    name: "Enterprise Software Portfolio",
  },
  healthcareAutomation: {
    key: "healthcare_automation_innovation",
    name: "Healthcare Automation & Innovation Portfolio",
  },
} as const;
