import { type TravelStatsModel } from './travelStats';

type TravelStatsPanelProps = {
  model: TravelStatsModel;
};

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
                        <strong>{stat.displayValue}</strong>
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
