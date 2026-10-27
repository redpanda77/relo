/**
 * The state wash behind Now's deck: a breathing radial ellipse, three drifting blurred blobs and a
 * vignette. CSS only (now.css `.now-wash`); the state's colours arrive as variables on the deck
 * (`headerVars`, lib/now-header.ts). Only opacity and transform animate.
 */
export function NowWash() {
  return (
    <div aria-hidden="true" className="now-wash">
      <i className="now-wash-glow" />
      <i className="now-wash-blob" data-blob="1" />
      <i className="now-wash-blob" data-blob="2" />
      <i className="now-wash-blob" data-blob="3" />
      <i className="now-wash-vignette" />
    </div>
  )
}
