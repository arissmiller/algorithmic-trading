export default function RouteFallback({ label = "Loading page..." }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="rounded border border-border bg-surface-1 px-4 py-3 text-xs uppercase tracking-widest text-text-secondary">
        {label}
      </div>
    </div>
  );
}
