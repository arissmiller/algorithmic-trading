import CryptoTrailingGridBacktestWorkspace from "./CryptoTrailingGridBacktestWorkspace";

export default function CryptoLinearRegressionTrailingGridBacktestPage({
  apiPrefix,
}: {
  apiPrefix: string;
}) {
  return (
    <CryptoTrailingGridBacktestWorkspace
      apiPrefix={apiPrefix}
      strategyVariant="linearRegression"
    />
  );
}
