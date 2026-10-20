import { memo, useState } from 'react';
import { MAPS, type MapId } from '@risk/engine';
import { continentColor } from './Map';

/**
 * A small, static picture of a board for choosing one: every territory in its region's colour, sea links
 * dashed, and a legend of regions with their bonuses. Hover a region in the legend to pick it out on the map.
 */
export const MapPreview = memo(function MapPreview({ mapId, players }: { mapId: MapId; players?: number }) {
  const map = MAPS[mapId] ?? MAPS.classic;
  const [focus, setFocus] = useState<string | null>(null);
  const [W, H] = map.viewBox;
  const seats = Math.max(2, Math.min(players ?? map.maxPlayers, map.maxPlayers));
  const regions = [...map.continents].sort((a, b) => b.bonus - a.bonus || a.name.localeCompare(b.name));

  return (
    <figure className="map-preview" aria-label={`${map.name} map preview`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${map.name}: ${map.territories.length} territories in ${map.continents.length} regions`}>
        <rect width={W} height={H} className="ocean" />
        <g className="sea-links">
          {map.seaLinks.map((l) => {
            const A = map.territoryById[l.a];
            const B = map.territoryById[l.b];
            if (!A || !B) return null;
            if (l.wrap) {
              const [left, right] = A.x < B.x ? [A, B] : [B, A];
              return (
                <g key={`${l.a}-${l.b}`}>
                  <line x1={left.x} y1={left.y} x2={0} y2={left.y} />
                  <line x1={right.x} y1={right.y} x2={W} y2={right.y} />
                </g>
              );
            }
            return <line key={`${l.a}-${l.b}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} />;
          })}
        </g>
        <g>
          {map.territories.map((t) => (
            <path
              key={t.id}
              d={t.path}
              className={`preview-territory${focus && focus !== t.continent ? ' faded' : ''}`}
              fill={continentColor(map, t.continent)}
            >
              <title>
                {t.name} · {map.continentById[t.continent]?.name}
              </title>
            </path>
          ))}
        </g>
      </svg>
      <figcaption>
        <div className="map-preview-stats">
          <strong>{map.name}</strong> · {map.territories.length} territories · {map.continents.length} regions · up to {map.maxPlayers} players ·{' '}
          {map.startingArmies(seats)} starting armies each with {seats} players
        </div>
        <ul className="map-preview-regions">
          {regions.map((c) => (
            <li
              key={c.id}
              tabIndex={0}
              onMouseEnter={() => setFocus(c.id)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(c.id)}
              onBlur={() => setFocus(null)}
              title={`${c.name}: ${c.territories.length} territories, +${c.bonus} a turn for holding them all`}
            >
              <span className="swatch" style={{ background: continentColor(map, c.id) }} />
              {c.name} <span className="muted">+{c.bonus}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
});

/** A board's silhouette for a map picker: every territory in one ink, no labels or links. */
export const MapThumb = memo(function MapThumb({ mapId }: { mapId: MapId }) {
  const map = MAPS[mapId] ?? MAPS.classic;
  const [W, H] = map.viewBox;
  return (
    <svg className="map-thumb" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {map.territories.map((t) => (
        <path key={t.id} d={t.path} />
      ))}
    </svg>
  );
});
