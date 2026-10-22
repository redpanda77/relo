/**
 * The launch film, right under the hero. Its files live wherever the server's RELO_LANDING_FILM_URL
 * points (the landing bootstrap carries `film.base`, and the page's CSP allows that one media origin).
 */
import { FilmPlayer } from "@/components/film-player"

export function LandingFilm({ base }: { base: string }) {
  return (
    <section className="landing-film" aria-label="Relo in 40 seconds">
      <div className="landing-wrap">
        <FilmPlayer base={base} name="launch" label="Relo launch film: agents, scripts and apps report live status, alerts and approvals to one place on your iPhone" />
      </div>
    </section>
  )
}
