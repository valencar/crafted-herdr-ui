import type { ReactNode } from "react";

type Props = {
  label: string;
  value: string;
  unit?: string;
  foot?: ReactNode;
  /** Between the value and the foot, e.g. a status bar. */
  children?: ReactNode;
};

/** One figure of the Dashboard's "Right now" row. */
export function MetricTile({ label, value, unit, foot, children }: Props) {
  return (
    <div className="tile" role="group" aria-label={label}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        <span className="tile-num">{value}</span>
        {unit && (
          <>
            {" "}
            <span className="tile-unit">{unit}</span>
          </>
        )}
      </div>
      {children}
      {foot && <div className="tile-foot">{foot}</div>}
    </div>
  );
}
