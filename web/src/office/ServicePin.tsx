// The service pin (shared/tenure.ts), as on the avatar's shirt, for the profile card.
import { daysSince, pinOf, tenureTitle } from "../../../shared/tenure";

export function ServicePin({ since }: { since: string }) {
  const { tier, years } = pinOf(daysSince(since));
  return (
    <span className={`service-pin pin-${tier}`} title={tenureTitle(since)}>
      <i />
      {years ? <b>{years}</b> : null}
    </span>
  );
}
