'use client';
import Markdown from 'markdown-to-jsx';
import NextImage from '@/components/layout/NextImage';
import PreCustom, { type PreChild } from './PreCustom';

// TODO: Consolidate image parsing and `****highlight****` parsing into a unified
// custom formatter shared with CMS previews and formatLabels.ts.
// Markdown images: `![alt-blurhash](url)` where the first "-" splits alt from blurhash.
const MarkdownRenderer = ({ markdown }: { markdown: string }) => {
  /*
    Alt prop in img is taken from markdown, an example image is like this:
    "![alt-data:image/png;base64,BLURHASHVALUE](imageurl)"

    usually the [x] represents the alt prop, for efficiency porpuses it now will be handled as [alt-blurhashdataurl]
  */

  return (
    <Markdown
      options={{
        forceBlock: true,
        overrides: {
          h1: {
            component: ({ children }) => (
              <h1 className="text-main font-bold">{children}</h1>
            ),
          },
          h2: {
            component: ({ children }) => (
              <h2 className="text-main font-bold">{children}</h2>
            ),
          },
          h3: {
            component: ({ children }) => (
              <h3 className="text-main font-bold">{children}</h3>
            ),
          },
          h4: {
            component: ({ children }) => (
              <h4 className="text-main font-semibold">{children}</h4>
            ),
          },
          h5: {
            component: ({ children }) => (
              <h5 className="text-main font-semibold">{children}</h5>
            ),
          },
          h6: {
            component: ({ children }) => (
              <h6 className="text-main font-semibold">{children}</h6>
            ),
          },
          p: {
            component: ({ children }) => {
              // For markdown-to-jsx, we need to check if children contain only images differently
              const childrenArray = Array.isArray(children)
                ? children
                : [children];
              const isOnlyImages = childrenArray.every(
                (child) =>
                  typeof child === 'object' &&
                  child !== null &&
                  'type' in child &&
                  child.type === 'img'
              );

              if (isOnlyImages) {
                return <>{children}</>;
              }

              return <p>{children}</p>;
            },
          },
          pre: {
            component: ({ children }) => {
              return <PreCustom>{children as PreChild}</PreCustom>;
            },
          },
          img: {
            component: ({ src, alt }) => {
              if (!alt) throw new Error('alt should never be undefined');

              const data = alt.split('-');
              const altText = data[0];
              const blurhash = data[1];

              // Ensure src is a string before passing to NextImage
              const imageSrc = typeof src === 'string' ? src : '';

              return (
                <NextImage src={imageSrc} alt={altText} blurhash={blurhash} />
              );
            },
          },
        },
      }}
    >
      {markdown}
    </Markdown>
  );
};

export default MarkdownRenderer;
