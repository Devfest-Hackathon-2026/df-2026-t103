export function HxSkeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`animate-pulse rounded-sm bg-hx-surface-subtle ${className}`} />
  );
}

/** 表の骨格を保持し、リロードで列幅を大きく揺らさないための行単位スケルトン（§8.3/§17.3）。 */
export function HxSkeletonRows({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} className="h-11 border-b border-hx-divider">
          {Array.from({ length: columns }, (_, col) => (
            <td key={col} className="px-3 py-2.5">
              <HxSkeleton className="h-4 w-4/5" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
