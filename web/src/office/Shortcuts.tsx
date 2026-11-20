import { Icon } from "../icons";

const KEYS: [string, string][] = [
  ["1", "Toggle camera"],
  ["2", "Toggle microphone"],
  ["3", "Set status to Available"],
  ["4", "Set status to Away"],
  ["5", "Set status to Focusing"],
  [":", "React with an emoji"],
  ["E", "Emote (dance, floss, faint…): a few seconds, or until you move"],
  ["G", "Gallery"],
  ["M", "Map"],
  ["O", "Open or close the door of the room you're in"],
  ["C", "Show or hide the People panel"],
  ["F", "Find people"],
  ["H", "Go to your desk"],
  ["+ / −", "Zoom in / out"],
  ["↑ ↓ ← → or WASD", "Move"],
  ["Double-click", "Walk there"],
  ["Drag", "Look around (moving recenters)"],
  ["Esc", "Close everything"],
  ["?", "This list"],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal keys" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Keyboard shortcuts</h3>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <dl>
          {KEYS.map(([k, v]) => (
            <div key={k} className="key-row">
              <dt><kbd>{k}</kbd></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
