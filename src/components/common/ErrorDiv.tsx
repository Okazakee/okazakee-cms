import { OctagonX } from 'lucide-react';

export const ErrorDiv = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="my-52 text-2xl md:text-6xl flex items-center justify-center mx-auto">
      <OctagonX className="mr-5 md:mr-10 p-1 md:p-0" size={50} />
      <h1>{children}</h1>
    </div>
  );
};
