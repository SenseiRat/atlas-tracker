import { formatDistance } from '../lib/format';
import type { MeasurementSystem, Stats } from '../types';

type LeaderboardPanelProps = {
  stats: Stats | null;
  measurementSystem: MeasurementSystem;
};

export function LeaderboardPanel({ stats, measurementSystem }: LeaderboardPanelProps) {
  const formatLeaderboardValue = (categoryId: string, value?: number) => {
    if (value === undefined || value === null) return '--';
    if (categoryId === 'miles') return formatDistance(value, measurementSystem);
    return Math.round(value).toLocaleString();
  };

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div>
          <h3>Leaderboard</h3>
          <p>Public profile standings based on coverage, travel, and earned achievements.</p>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span>Your position</span>
          <strong>
            {stats?.leaderboard.current_profile?.eligible
              ? `#${stats.leaderboard.current_profile.overall_rank ?? '--'}`
              : '--'}
          </strong>
          <small>
            {stats?.leaderboard.current_profile?.leader_categories?.length
              ? `Leading: ${stats.leaderboard.current_profile.leader_categories.join(', ')}`
              : stats?.leaderboard.current_profile?.eligible
                ? 'No category leads yet'
                : 'Only public profiles rank'}
          </small>
        </div>
        <div className="stat-card">
          <span>Public profiles</span>
          <strong>{stats?.leaderboard.public_profile_count ?? 0}</strong>
        </div>
        <div className="stat-card">
          <span>Country rank</span>
          <strong>
            {stats?.leaderboard.current_profile?.eligible
              ? `#${stats.leaderboard.current_profile.country_rank ?? '--'}`
              : '--'}
          </strong>
        </div>
        <div className="stat-card">
          <span>Achievement rank</span>
          <strong>
            {stats?.leaderboard.current_profile?.eligible
              ? `#${stats.leaderboard.current_profile.achievement_rank ?? '--'}`
              : '--'}
          </strong>
        </div>
      </div>

      <div className="leaderboard-grid">
        <section className="leaderboard-panel">
          <div className="panel-header">
            <div>
              <h3>Overall</h3>
              <p>Weighted score across coverage, travel, and achievements.</p>
            </div>
          </div>
          <div className="leaderboard-list">
            {(stats?.leaderboard.top_overall ?? []).map((entry, index) => (
              <div key={entry.profile_id} className="leaderboard-row">
                <span className="leaderboard-rank">#{index + 1}</span>
                <div className="leaderboard-entry">
                  <strong>{entry.name}</strong>
                  <small>
                    {(entry.countries ?? 0).toLocaleString()} countries · {formatDistance(entry.miles ?? 0, measurementSystem)} ·{' '}
                    {(entry.achievements ?? 0).toLocaleString()} achievements
                  </small>
                </div>
                <span className="leaderboard-score">
                  {Math.round(entry.overall_score ?? 0).toLocaleString()}
                  <small>pts</small>
                </span>
              </div>
            ))}
          </div>
        </section>

        {(stats?.leaderboard.categories ?? []).map((category) => (
          <section className="leaderboard-panel" key={category.id}>
            <div className="panel-header">
              <div>
                <h3>{category.label}</h3>
                <p>Current public leaders in this category.</p>
              </div>
            </div>
            <div className="leaderboard-list">
              {category.leaders.map((entry, index) => (
                <div key={`${category.id}-${entry.profile_id}`} className="leaderboard-row">
                  <span className="leaderboard-rank">#{index + 1}</span>
                  <strong className="leaderboard-name">{entry.name}</strong>
                  <span className="leaderboard-score">{formatLeaderboardValue(category.id, entry.value)}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
