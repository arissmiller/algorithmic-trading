export const APP_PATHS = {
  stocksBacktest: "/backtests/stocks",
  portfolioVsSp500: "/backtests/portfolio-vs-sp500",
  cryptoBacktest: "/backtests/crypto",
  cryptoSelloffDetection: "/crypto/selloff-detection",
  cryptoGridBacktest: "/crypto/grid",
  cryptoTrailingGridBacktest: "/crypto/trailing-grid",
  advancedIndustrialsLive: "/portfolios/advanced-industrials/live",
  advancedIndustrialsBacktest: "/portfolios/advanced-industrials/backtest",
  enterpriseSoftwareLive: "/portfolios/enterprise-software/live",
  enterpriseSoftwareBacktest: "/portfolios/enterprise-software/backtest",
  healthcareAutomationLive: "/portfolios/healthcare-automation/live",
  healthcareAutomationBacktest: "/portfolios/healthcare-automation/backtest",
} as const;

export const APP_NAV_GROUPS = [
  {
    label: "Backtesting",
    pages: [
      { path: APP_PATHS.stocksBacktest, label: "Stocks/ETF Backtest" },
      { path: APP_PATHS.portfolioVsSp500, label: "Weighted Portfolio Backtest" },
      { path: APP_PATHS.cryptoBacktest, label: "Crypto Backtest" },
      { path: APP_PATHS.cryptoSelloffDetection, label: "Crypto Selloff Detection" },
      { path: APP_PATHS.cryptoGridBacktest, label: "Fixed Grid Backtest" },
      { path: APP_PATHS.cryptoTrailingGridBacktest, label: "Trailing Grid Backtest" },
    ],
  },
  {
    label: "Live Portfolios",
    pages: [
      { path: APP_PATHS.advancedIndustrialsLive, label: "AIA Live" },
      { path: APP_PATHS.advancedIndustrialsBacktest, label: "AIA Backtest" },
      { path: APP_PATHS.enterpriseSoftwareLive, label: "Enterprise Software Live" },
      { path: APP_PATHS.enterpriseSoftwareBacktest, label: "Enterprise Software Backtest" },
      { path: APP_PATHS.healthcareAutomationLive, label: "Healthcare Automation Live" },
      { path: APP_PATHS.healthcareAutomationBacktest, label: "Healthcare Automation Backtest" },
    ],
  },
] as const;
