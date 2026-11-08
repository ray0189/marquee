import type { SyntheticEvent } from "react";

/** onLoad for <img data-fade>: reveals the image (see index.css). A handler on the element itself, because
 *  images already in the memory cache finish loading before React inserts them, out of reach of a
 *  document-level listener. */
export const fadeIn = (e: SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.dataset.loaded = "";
};
