export type CourseWebPlayerProps = {
  source: string;
  onProgress: (seconds: number) => void;
};

// Metro selects the .web implementation for the installed PWA.
export default function CourseWebPlayer(_props: CourseWebPlayerProps) {
  return null;
}
