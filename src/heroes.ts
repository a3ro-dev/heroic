export interface Hero {
  id: string;
  name: string;
  note: string;
  accent: string;
  url: string;
}

export const HEROES: Hero[] = [
  { id: "hulk", name: "Hulk", note: "Smash-sized, 2.7 m", accent: "#7cc142", url: "/heroes/hulk.glb" },
  { id: "infinity-ultron", name: "Infinity Ultron", note: "What If…? multiverse", accent: "#e8b84a", url: "/heroes/infinity-ultron.glb" },
  { id: "ultron-prime", name: "Ultron Prime", note: "Contest of Champions", accent: "#d9dde2", url: "/heroes/ultron-prime.glb" },
];
