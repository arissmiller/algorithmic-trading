import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import App from "../App";
import { API_PREFIX, PORTFOLIOS } from "./constants";
import { APP_PATHS } from "./navigation";
import RouteFallback from "./RouteFallback";

const BacktestingWorkspace = lazy(() => import("../features/backtesting/BacktestingWorkspace"));
const CryptoSelloffDetectionPage = lazy(() => import("../components/CryptoSelloffDetectionPage"));
const CryptoGridBacktestPage = lazy(() => import("../components/CryptoGridBacktestPage"));
const CryptoTrailingGridBacktestPage = lazy(() => import("../components/CryptoTrailingGridBacktestPage"));
const CryptoLinearRegressionTrailingGridBacktestPage = lazy(
  () => import("../components/CryptoLinearRegressionTrailingGridBacktestPage")
);
const PortfolioVsSp500Page = lazy(() => import("../components/PortfolioVsSp500Page"));
const LivePortfolioPage = lazy(() => import("../components/LivePortfolioPage"));
const LivePortfolioBacktestPage = lazy(() => import("../components/LivePortfolioBacktestPage"));

const STOCK_BENCHMARK_SYMBOL = "^GSPC";
const CRYPTO_BENCHMARK_SYMBOL = "BTC/USD";

function withSuspense(node: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<App />}>
        <Route index element={<Navigate to={APP_PATHS.stocksBacktest} replace />} />
        <Route
          path={APP_PATHS.stocksBacktest}
          element={withSuspense(
            <BacktestingWorkspace
              title="Stocks/ETF Backtesting"
              benchmarkSymbol={STOCK_BENCHMARK_SYMBOL}
              defaultSymbol="AAPL"
              symbolMode="stocks"
            />
          )}
        />
        <Route
          path={APP_PATHS.portfolioVsSp500}
          element={withSuspense(<PortfolioVsSp500Page apiPrefix={API_PREFIX} />)}
        />
        <Route
          path={APP_PATHS.cryptoBacktest}
          element={withSuspense(
            <BacktestingWorkspace
              title="Crypto Backtesting"
              benchmarkSymbol={CRYPTO_BENCHMARK_SYMBOL}
              defaultSymbol="BTC"
              symbolMode="crypto"
            />
          )}
        />
        <Route
          path={APP_PATHS.cryptoSelloffDetection}
          element={withSuspense(<CryptoSelloffDetectionPage apiPrefix={API_PREFIX} />)}
        />
        <Route
          path={APP_PATHS.cryptoGridBacktest}
          element={withSuspense(<CryptoGridBacktestPage apiPrefix={API_PREFIX} />)}
        />
        <Route
          path={APP_PATHS.cryptoTrailingGridBacktest}
          element={withSuspense(<CryptoTrailingGridBacktestPage apiPrefix={API_PREFIX} />)}
        />
        <Route
          path={APP_PATHS.cryptoLinearRegressionTrailingGridBacktest}
          element={withSuspense(
            <CryptoLinearRegressionTrailingGridBacktestPage apiPrefix={API_PREFIX} />
          )}
        />
        <Route
          path={APP_PATHS.advancedIndustrialsLive}
          element={withSuspense(
            <LivePortfolioPage
              apiPrefix={API_PREFIX}
              portfolioKey={PORTFOLIOS.advancedIndustrials.key}
              defaultPortfolioName={PORTFOLIOS.advancedIndustrials.name}
            />
          )}
        />
        <Route
          path={APP_PATHS.advancedIndustrialsBacktest}
          element={withSuspense(
            <LivePortfolioBacktestPage
              apiPrefix={API_PREFIX}
              portfolioKey={PORTFOLIOS.advancedIndustrials.key}
              defaultPortfolioName={PORTFOLIOS.advancedIndustrials.name}
            />
          )}
        />
        <Route
          path={APP_PATHS.enterpriseSoftwareLive}
          element={withSuspense(
            <LivePortfolioPage
              apiPrefix={API_PREFIX}
              portfolioKey={PORTFOLIOS.enterpriseSoftware.key}
              defaultPortfolioName={PORTFOLIOS.enterpriseSoftware.name}
            />
          )}
        />
        <Route
          path={APP_PATHS.enterpriseSoftwareBacktest}
          element={withSuspense(
            <LivePortfolioBacktestPage
              apiPrefix={API_PREFIX}
              portfolioKey={PORTFOLIOS.enterpriseSoftware.key}
              defaultPortfolioName={PORTFOLIOS.enterpriseSoftware.name}
            />
          )}
        />
        <Route
          path={APP_PATHS.healthcareAutomationLive}
          element={withSuspense(
            <LivePortfolioPage
              apiPrefix={API_PREFIX}
              portfolioKey={PORTFOLIOS.healthcareAutomation.key}
              defaultPortfolioName={PORTFOLIOS.healthcareAutomation.name}
            />
          )}
        />
        <Route
          path={APP_PATHS.healthcareAutomationBacktest}
          element={withSuspense(
            <LivePortfolioBacktestPage
              apiPrefix={API_PREFIX}
              portfolioKey={PORTFOLIOS.healthcareAutomation.key}
              defaultPortfolioName={PORTFOLIOS.healthcareAutomation.name}
            />
          )}
        />
        <Route path="*" element={<Navigate to={APP_PATHS.stocksBacktest} replace />} />
      </Route>
    </Routes>
  );
}
