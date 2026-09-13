export function HomeIllustration(): React.ReactElement {
  return (
    <svg
      className="home-illustration"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 190"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M 116 136 v 12 a 9 9 0 0 0 9 9 h 29 a 12 12 0 0 0 8.5 -3.5 l 20 -20 a 12 12 0 0 1 8.5 -3.5 h 16"
        stroke="#d8d8d8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="144" cy="157" r="3.5" fill="#fff" stroke="#171717" strokeWidth="1.3" />
      <circle cx="181" cy="135" r="3.5" fill="#fff" stroke="#171717" strokeWidth="1.3" />
      <circle cx="210" cy="130" r="5" fill="#ebcb45" />
      <g transform="rotate(-9 110 78)" strokeLinejoin="round">
        <path d="M 74 24 h 55 l 16 16 v 92 H 74 V 24 Z" fill="#fff" stroke="#171717" strokeWidth="1.6" />
        <path d="M 129 24 v 16 h 16" fill="#ebcb45" stroke="#171717" strokeWidth="1.4" />
        <g stroke="#171717" strokeWidth="1.25">
          <circle cx="89" cy="60" r="3.5" />
          <circle cx="89" cy="79" r="3.5" />
          <circle cx="89" cy="98" r="3.5" />
        </g>
        <path d="M 102 60 h 25 M 102 79 h 21 M 102 98 h 25" stroke="#d8d8d8" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M 85 118 h 25" stroke="#d8d8d8" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}
