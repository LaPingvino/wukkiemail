// Small built-in shortcode table for inline emoji typing.
// Type ':smile:' and we swap in 😄. Covers the most-used shortcodes;
// users wanting the full Unicode set can paste from a system picker.
//
// Conversion happens inside the composer's input handler, not at send,
// so the user sees the substitution as they type — matches Slack/Element.

const SHORTCODES: Record<string, string> = {
  smile: '😄', laughing: '😆', joy: '😂', rofl: '🤣', sweat_smile: '😅',
  grin: '😁', wink: '😉', heart_eyes: '😍', kissing: '😗', thinking: '🤔',
  neutral_face: '😐', expressionless: '😑', no_mouth: '😶', smirk: '😏',
  unamused: '😒', sleepy: '😪', sleeping: '😴', sob: '😭', cry: '😢',
  fearful: '😨', cold_sweat: '😰', flushed: '😳', dizzy_face: '😵',
  rage: '😡', angry: '😠', triumph: '😤', mask: '😷', sunglasses: '😎',
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  ok_hand: '👌', wave: '👋', clap: '👏', pray: '🙏', muscle: '💪',
  point_up: '☝️', point_right: '👉', point_left: '👈', point_down: '👇',
  raised_hands: '🙌', open_hands: '👐', folded_hands: '🙏', handshake: '🤝',
  heart: '❤️', broken_heart: '💔', sparkling_heart: '💖', two_hearts: '💕',
  fire: '🔥', star: '⭐', sparkles: '✨', boom: '💥', tada: '🎉',
  rocket: '🚀', bulb: '💡', warning: '⚠️', check: '✅', x: '❌',
  question: '❓', exclamation: '❗', eyes: '👀', zzz: '💤',
  coffee: '☕', beer: '🍺', pizza: '🍕', cake: '🎂',
  sun: '☀️', moon: '🌙', cloud: '☁️', umbrella: '☔', snowflake: '❄️',
  dog: '🐶', cat: '🐱', mouse: '🐭', fox: '🦊', bear: '🐻',
  shrug: '🤷', facepalm: '🤦', clown: '🤡', skull: '💀', ghost: '👻',
  robot: '🤖', alien: '👽', poop: '💩',
};

const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

// Replace any :shortcode: with its emoji. Leaves unknown shortcodes
// alone so users can keep typing :emoji-name: as plain text.
export function expandShortcodes(text: string): string {
  return text.replace(SHORTCODE_RE, (whole, name: string) => {
    const e = SHORTCODES[name.toLowerCase()];
    return e ?? whole;
  });
}
