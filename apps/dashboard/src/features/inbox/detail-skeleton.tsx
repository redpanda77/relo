/**
 * The side sheet's shape while the detail loads, in the body's own order: the header (origin,
 * title, status), then the work (a few lines), then the Details list.
 */
export function DetailSkeleton() {
  return (
    <div className="detail" data-variant="panel" aria-hidden="true">
      <div className="detail-header">
        <div className="skeleton h-3 w-44" />
        <div className="skeleton h-7 w-3/4" />
        <div className="flex gap-3">
          <div className="skeleton h-6 w-24 rounded-full" />
          <div className="skeleton h-4 w-20 self-center" />
        </div>
      </div>
      <div className="detail-columns">
        <div className="space-y-3">
          <div className="skeleton h-3.5 w-full" />
          <div className="skeleton h-3.5 w-11/12" />
          <div className="skeleton h-3.5 w-2/3" />
        </div>
        <div className="skeleton h-48 w-full rounded-2xl" />
      </div>
    </div>
  )
}
