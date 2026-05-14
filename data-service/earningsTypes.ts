export interface EarningsEvent {
  date: string;
  fiscalDateEnding: string | null;
  reportedEps: number | null;
  estimatedEps: number | null;
  surprise: number | null;
  surprisePercentage: number | null;
}

