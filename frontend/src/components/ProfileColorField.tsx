import type { CSSProperties } from 'react';
import { normalizeHexColor, profilePalette } from '../lib/colors';

type ProfileColorFieldProps = {
  value: string;
  onChange: (color: string) => void;
  label?: string;
};

export function ProfileColorField({ value, onChange, label = 'Color' }: ProfileColorFieldProps) {
  const normalized = normalizeHexColor(value);
  return (
    <div className="profile-color-picker" role="radiogroup" aria-label={label}>
      <span className="profile-color-picker__label">{label}</span>
      <div className="profile-color-grid">
        {profilePalette.map((color) => (
          <button
            key={color}
            type="button"
            className={`profile-color-option${normalized === color ? ' profile-color-option--active' : ''}`}
            onClick={() => onChange(color)}
            role="radio"
            aria-checked={normalized === color}
            aria-label={`Use ${color}`}
          >
            <span className="profile-color-option__frame" aria-hidden="true">
              <span className="profile-color-option__swatch" style={{ '--swatch-color': color } as CSSProperties} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
