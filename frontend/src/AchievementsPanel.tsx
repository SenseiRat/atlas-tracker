import type { AchievementItem, AchievementModel, MilestoneAchievementItem, TieredAchievementItem } from './achievements';

type AchievementsPanelProps = {
  model: AchievementModel;
};

function StatusPill({ status }: { status: AchievementItem['status'] }) {
  const label = status === 'unlocked' ? 'Unlocked' : status === 'in_progress' ? 'In Progress' : 'Locked';
  return <span className={`achievement-status achievement-status--${status}`}>{label}</span>;
}

function TieredCard({ achievement }: { achievement: TieredAchievementItem }) {
  return (
    <article className={`achievement-card achievement-card--${achievement.status}`}>
      <div className="achievement-card__header">
        <div>
          <span>Tiered</span>
          <h4>{achievement.name}</h4>
        </div>
        <StatusPill status={achievement.status} />
      </div>

      <p>{achievement.description}</p>

      <div className="achievement-card__stats">
        <div>
          <strong>{achievement.currentValueLabel}</strong>
          <small>Current</small>
        </div>
        <div>
          <strong>{achievement.currentTierLabel ?? 'No tier yet'}</strong>
          <small>Current tier</small>
        </div>
        <div>
          <strong>{achievement.nextTierLabel ?? 'Complete'}</strong>
          <small>Next tier</small>
        </div>
      </div>

      <div className="achievement-progress">
        <div className="achievement-progress__bar" style={{ width: `${achievement.progressPercent}%` }} />
      </div>
      <small>{achievement.progressLabel}</small>

      {achievement.unlockedTierHistory.length > 0 && (
        <div className="achievement-chip-list">
          {achievement.unlockedTierHistory.map((tier) => (
            <span key={`${achievement.id}-${tier.threshold}`} className="achievement-chip">
              {tier.label}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function MilestoneCard({ achievement }: { achievement: MilestoneAchievementItem }) {
  return (
    <article className={`achievement-card achievement-card--${achievement.status}`}>
      <div className="achievement-card__header">
        <div>
          <span>Milestone</span>
          <h4>{achievement.name}</h4>
        </div>
        <StatusPill status={achievement.status} />
      </div>

      <p>{achievement.description}</p>
      <div className="achievement-milestone">
        <strong>{achievement.unlocked ? 'Completed' : 'Not unlocked yet'}</strong>
      </div>
    </article>
  );
}

function AchievementCard({ achievement }: { achievement: AchievementItem }) {
  return achievement.type === 'tiered' ? <TieredCard achievement={achievement} /> : <MilestoneCard achievement={achievement} />;
}

export function AchievementsPanel({ model }: AchievementsPanelProps) {
  if (model.sections.length === 0) {
    return (
      <div className="travel-stats-empty">
        <h4>No achievements available yet</h4>
        <p>Add trips or visits to start unlocking travel milestones.</p>
      </div>
    );
  }

  return (
    <div className="achievements-page">
      <div className="achievement-summary-grid">
        <article className="achievement-summary-card">
          <span>Unlocked badges</span>
          <strong>
            {model.summary.unlockedBadges} / {model.summary.totalBadges}
          </strong>
        </article>
        <article className="achievement-summary-card">
          <span>Completed achievements</span>
          <strong>
            {model.summary.completedAchievements} / {model.summary.totalAchievements}
          </strong>
        </article>
        <article className="achievement-summary-card">
          <span>In progress</span>
          <strong>{model.summary.inProgressAchievements}</strong>
        </article>
      </div>

      <div className="achievement-sections">
        {model.sections.map((section) => (
          <section key={section.id} className="achievement-section">
            <div className="achievement-section__header">
              <div>
                <h4>{section.label}</h4>
                <p>
                  {section.unlockedBadges} / {section.totalBadges} badges unlocked
                </p>
              </div>
              <small>{section.items.length} achievements</small>
            </div>

            <div className="achievement-grid">
              {section.items.map((achievement) => (
                <AchievementCard key={achievement.id} achievement={achievement} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
