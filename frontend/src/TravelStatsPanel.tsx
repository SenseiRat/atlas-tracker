import { hemisphereQuadrantLabels, type HemisphereQuadrant, type TravelStatsModel } from './travelStats';

type TravelStatsPanelProps = {
  model: TravelStatsModel;
};

// Circle centered at (56, 56) with radius 40, split by the equator and prime
// meridian into one wedge per hemisphere quadrant.
const hemisphereWedgePaths: Record<HemisphereQuadrant, string> = {
  NE: 'M56 56 L56 16 A40 40 0 0 1 96 56 Z',
  SE: 'M56 56 L96 56 A40 40 0 0 1 56 96 Z',
  SW: 'M56 56 L56 96 A40 40 0 0 1 16 56 Z',
  NW: 'M56 56 L16 56 A40 40 0 0 1 56 16 Z',
};

/** Globe diagram: the equator and prime meridian divide the world into four
 * quadrants; visited ones are filled, so SE-only (Australia) reads differently
 * from SW (South America) or NW/NE (North America). */
function HemisphereGlobe({ quadrants }: { quadrants: HemisphereQuadrant[] }) {
  const covered = new Set(quadrants);
  const description = quadrants.map((quadrant) => hemisphereQuadrantLabels[quadrant]).join(', ') || 'none';
  return (
    <span className="hemisphere-globe" role="img" aria-label={`Hemisphere quadrants visited: ${description}`}>
      <svg viewBox="0 0 112 112" focusable="false" aria-hidden="true">
        {(['NE', 'SE', 'SW', 'NW'] as const).map((quadrant) => (
          <path
            key={quadrant}
            d={hemisphereWedgePaths[quadrant]}
            className={`hemisphere-globe__quadrant${covered.has(quadrant) ? ' hemisphere-globe__quadrant--covered' : ''}`}
          />
        ))}
        <circle className="hemisphere-globe__outline" cx="56" cy="56" r="40" />
        <line className="hemisphere-globe__axis" x1="16" y1="56" x2="96" y2="56" />
        <line className="hemisphere-globe__axis" x1="56" y1="16" x2="56" y2="96" />
        <text className="hemisphere-globe__label" x="56" y="11">N</text>
        <text className="hemisphere-globe__label" x="56" y="110">S</text>
        <text className="hemisphere-globe__label" x="7" y="59">W</text>
        <text className="hemisphere-globe__label" x="105" y="59">E</text>
      </svg>
      <span className="hemisphere-globe__caption">{covered.size} of 4 quadrants</span>
    </span>
  );
}

export function TravelStatsPanel({ model }: TravelStatsPanelProps) {
  if (model.heroStats.length === 0 && model.highlightStats.length === 0 && model.sections.length === 0) {
    return (
      <div className="travel-stats-empty">
        <h4>No travel stats yet</h4>
        <p>Add trips or dated visits to populate the travel stats page.</p>
      </div>
    );
  }

  return (
    <div className="travel-stats-page">
      {model.heroStats.length > 0 && (
        <section className="travel-stats-section">
          <div className="travel-stats-section__header">
            <h4>Hero</h4>
            <p>Core travel totals and headline records.</p>
          </div>
          <div className="travel-hero-grid">
            {model.heroStats.map((stat) => (
              <article key={stat.id} className="travel-hero-card">
                <span>{stat.label}</span>
                <strong>{stat.displayValue}</strong>
                {stat.detail && <small>{stat.detail}</small>}
              </article>
            ))}
          </div>
        </section>
      )}

      {model.highlightStats.length > 0 && (
        <section className="travel-stats-section">
          <div className="travel-stats-section__header">
            <h4>Highlights</h4>
            <p>Secondary callouts pulled from the same stat registry.</p>
          </div>
          <div className="travel-highlights-grid">
            {model.highlightStats.map((stat) => (
              <article key={stat.id} className="travel-highlight-card">
                <span>{stat.label}</span>
                <p>{stat.sentence}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {model.sections.length > 0 && (
        <section className="travel-stats-section">
          <div className="travel-stats-section__header">
            <h4>Stat Groups</h4>
            <p>Expandable groups keep the long tail of supported metrics readable.</p>
          </div>
          <div className="travel-groups">
            {model.sections.map((section, index) => (
              <details key={section.id} className="travel-group" open={index === 0}>
                <summary>
                  <span>{section.label}</span>
                  <small>{section.stats.length} stats</small>
                </summary>
                <div className="travel-group__grid">
                  {section.stats.map((stat) => (
                    <article key={stat.id} className="travel-stat-row">
                      <div>
                        <span>{stat.label}</span>
                        <p>{stat.description}</p>
                      </div>
                      <div className="travel-stat-row__value">
                        {stat.quadrants && stat.quadrants.length > 0 ? (
                          <HemisphereGlobe quadrants={stat.quadrants} />
                        ) : (
                          <strong>{stat.displayValue}</strong>
                        )}
                        {stat.detail && <small>{stat.detail}</small>}
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
