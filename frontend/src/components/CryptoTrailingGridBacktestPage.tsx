import CryptoTrailingGridBacktestWorkspace from "./CryptoTrailingGridBacktestWorkspace";

export default function CryptoTrailingGridBacktestPage({ apiPrefix }: { apiPrefix: string }) {
  return <CryptoTrailingGridBacktestWorkspace apiPrefix={apiPrefix} strategyVariant="sma" />;
}
