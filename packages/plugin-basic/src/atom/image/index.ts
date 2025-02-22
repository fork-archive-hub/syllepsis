import { BlockAtom, getPx, INodeInfo, SylApi, SylController, SylPlugin } from '@syllepsis/adapter';
import { DOMOutputSpecArray, Node, Node as ProsemirrorNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import {
  addAttrsByConfig,
  createFileInput,
  getFixSize,
  getFromDOMByConfig,
  isMatchObject,
  isObjectURL,
  setDOMAttrByConfig,
} from '../../utils';
import { ImageAttrs, ImageProps, IUpdateImageProps, TUploadDataType } from './types';
import {
  checkDomain,
  constructAttrs,
  correctSize,
  getImageFileList,
  getInputImageFiles,
  transformBlobFromObjectURL,
} from './utils';

const PLUGIN_NAME = 'image';

const BASE_CONFIG: ImageProps = {
  uploader: () => Promise.resolve(''),
  uploadBeforeInsert: false,
  placeholder: '',
  uploadType: 'blob' as const,
  listenDrop: true,
  listenPaste: true,
  maxLength: 20,
  uploadMaxWidth: 375,
};

const getMaxWidth = (editor?: SylApi) => {
  let maxWidth = editor?.command.image?.getConfiguration().maxWidth;
  if (maxWidth === undefined && editor) {
    maxWidth = editor.view.dom.scrollWidth - 40;
  }
  return maxWidth;
};
// parse the DOM of image which generated by the the ImagePlugin
const parseSylDOM = (
  dom: HTMLElement,
  fixClass: string,
  captionClass: string,
  addAttributes?: ImageProps['addAttributes'],
  maxWidth?: number,
) => {
  const image = dom.querySelector('img');
  if (!image) return false;

  const caption = dom.querySelector(captionClass) as HTMLInputElement | HTMLParagraphElement | null;
  const fixer = dom.querySelector(fixClass);

  const alt = (caption && (caption.innerText || (caption as HTMLInputElement).value)) || '';
  const src = (image && image.src) || '';
  let width = image.width;
  let height = image.height;
  if (maxWidth && width > maxWidth) {
    if (height) height = height / (width / maxWidth);
    width = maxWidth;
  }

  let align: ImageAttrs['align'] = dom.getAttribute('align') as ImageAttrs['align'];
  if (!align && fixer) {
    const className = fixer.className;
    if (className.includes('left')) align = 'left';
    else if (className.includes('right')) align = 'right';
  }

  const name = image.getAttribute('name') || '';
  const attrs: ImageAttrs = { src, alt, width, height, align, name };
  addAttributes && getFromDOMByConfig(addAttributes, dom, attrs);

  return attrs;
};

const uploadImg = async (editor: SylApi, src: string, fileName: string, config: ImageProps) => {
  let res: TUploadDataType = src;
  const { uploader, uploadType, onUploadError, deleteFailedUpload } = config;
  if (!uploader) throw new Error('Must provide uploader!');
  if (isObjectURL(src)) res = await transformBlobFromObjectURL(src);

  if (typeof res !== 'string' && uploadType === 'file') {
    res = new File([res as Blob], fileName, { type: res?.type });
  }
  try {
    const uploadRes = await uploader(res, {
      src,
    });
    if (typeof uploadRes === 'string') return { src: uploadRes || src };
    return { src, ...uploadRes };
  } catch (err) {
    if (deleteFailedUpload) {
      const nodeInfos = editor.getExistNodes(PLUGIN_NAME);
      nodeInfos.some(({ node, pos }) => {
        if (node.attrs.src === src) {
          editor.delete(pos, 1, { addToHistory: false });
          return true;
        }
      });
    }
    if (onUploadError) onUploadError(res, err);
    else throw err;
  }
};

const insertImageInEditor = (
  editor: SylApi,
  dataInfos: { image?: HTMLImageElement; attrs?: { src: string; [key: string]: any } }[],
  config: Partial<ImageProps>,
) => {
  const { state } = editor.view;
  const pos = state.selection.from;
  const $pos = state.doc.resolve(pos);
  const imageType = state.schema.nodes?.image;
  const images = [...dataInfos];
  const insertNodes = { type: 'doc', content: [] as INodeInfo[] };
  // when depth >= 2 and contained in table, inserting images will not update the selection,causes it to be inserted in reverse order
  const isInTable = $pos.node(1)?.type?.name === 'table' && $pos.depth >= 2;
  if (isInTable) {
    images.reverse();
  }
  images.forEach(({ image, attrs }) => {
    if (!image || !attrs) return;
    const imageAttrs: Partial<ImageAttrs> = {
      width: config.uploadMaxWidth ? Math.min(image.naturalWidth, config.uploadMaxWidth) : image.naturalWidth,
      name: image.getAttribute('name') || '',
      alt: '',
      align: imageType?.attrs?.align?.default || 'center',
      ...attrs,
    };
    if (isInTable) {
      editor.insert({ type: PLUGIN_NAME, attrs: imageAttrs });
    } else {
      insertNodes.content.push({ type: PLUGIN_NAME, attrs: imageAttrs });
    }
  });
  if (insertNodes.content.length && !isInTable) editor.insert(insertNodes, pos);
};

// get the picture file and judge whether to upload it in advance
const insertImageWithFiles = async (editor: SylApi, files: File[], config: Partial<ImageProps>) => {
  const results = await Promise.all(
    files.map(
      f =>
        new Promise(async resolve => {
          if (config.checkBeforeInsert && !(await config.checkBeforeInsert(f))) return resolve({});

          const url = window.URL.createObjectURL(f);
          let attrs: undefined | { src: string } = { src: url };
          const image = document.createElement('img');

          image.onload = async () => {
            if (config.uploadBeforeInsert) {
              const uploadRes = await uploadImg(editor, url, f.name, config);
              if (!uploadRes) resolve({});
              else attrs = { ...attrs, ...uploadRes };
            }
            resolve({ attrs, image });
          };
          image.onerror = async e => {
            const { onUploadError } = config;
            onUploadError && onUploadError(f, e as Event);
            resolve({});
          };

          image.src = attrs.src;
          image.setAttribute('name', f.name);
        }) as Promise<{ image?: HTMLImageElement; attrs?: { src: string } }>,
    ),
  );

  insertImageInEditor(editor, results, config);
};

const updateImageUrl = async (editor: SylApi, props: IUpdateImageProps, config: ImageProps) => {
  const { src, name } = props.attrs;
  if (props.state === undefined) props.state = {};
  const state = props.state;
  let imageAttrs: Partial<ImageAttrs> = {};

  try {
    // upload state, only single upload request is allowed in the same instance at the same time
    if (state.uploading || (!isObjectURL(src) && checkDomain(src, config))) {
      imageAttrs = await correctSize(props.attrs);
    } else {
      state.uploading = true;
      const attrs = await uploadImg(editor, src, name, config);
      state.uploading = false;
      if (!attrs) return;
      imageAttrs = await constructAttrs(props.attrs, attrs);
    }
    const nodePos = props.getPos();
    if (typeof nodePos !== 'number') return;
    const $pos = editor.view.state.doc.resolve(nodePos);
    const curNode = $pos.nodeAfter;
    // confirm the image node exist
    if (!curNode || curNode.type.name !== PLUGIN_NAME || curNode.attrs.src !== src) return;
    if (!isMatchObject({ ...props.attrs, ...imageAttrs }, props.attrs)) {
      editor.insertCard(PLUGIN_NAME, { ...props.attrs, ...imageAttrs }, { index: $pos.pos, deleteSelection: false });
      editor.delete($pos.pos + 1, 1, { addToHistory: false });
    }
  } finally {
    state.uploading = false;
  }
};

const createImageFileInput = (editor: SylApi, config: ImageProps) => {
  const input = createFileInput({
    multiple: true,
    accept: config.accept || 'image/*',
    onChange: (e: Event) => {
      const files = getInputImageFiles(e);
      insertImageWithFiles(editor, files, config);
    },
    getContainer: () => editor.root,
  });

  return input;
};
class ImageController extends SylController<ImageProps> {
  public fileInput: HTMLInputElement;

  public toolbar = {
    className: 'image',
    tooltip: 'image',
    icon: '' as any,
    handler: () => this.fileInput.click(),
  };

  constructor(editor: SylApi, props: ImageProps) {
    super(editor, props);
    if (Object.keys(props).length) this.props = { ...BASE_CONFIG, ...props };
    this.fileInput = createImageFileInput(editor, this.props);
    editor.root.appendChild(this.fileInput);
  }

  public command = {
    insertImages: (editor: SylApi, files: File[]) => insertImageWithFiles(editor, files, this.props),
    updateImageUrl: (editor: SylApi, props: IUpdateImageProps) => updateImageUrl(editor, props, this.props),
    getConfiguration: () => this.props,
  };

  public eventHandler = {
    handleClickOn(
      editor: SylApi,
      view: EditorView,
      pos: number,
      node: ProsemirrorNode,
      nodePos: number,
      event: MouseEvent,
    ) {
      if (node.type.name === PLUGIN_NAME) {
        const caption = (event.target as HTMLElement).closest('input');
        if (caption) {
          if (caption) caption.focus();
          const newTextSelection = TextSelection.create(view.state.doc, nodePos);
          view.dispatch(view.state.tr.setSelection(newTextSelection));
          return true;
        }
        // when the currently selected image is a picture, but the system behaves as a cursor, correct the selection.(real is 'Range')
        const { state, dispatch } = view;
        const curSelection = window.getSelection();
        if (curSelection && curSelection.type === 'Caret') {
          dispatch(state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
          return true;
        }
        return false;
      }
      return false;
    },
    handlePaste: (editor: SylApi, view: EditorView, e: Event) => {
      const event = e as ClipboardEvent;
      if ((this.props && !this.props.listenPaste) || !event.clipboardData) {
        return false;
      }
      const files = getImageFileList(event.clipboardData.files);
      const html = event.clipboardData.getData('text/html');
      const text = event.clipboardData.getData('text/plain');
      // if clipBoard get files and without any text and the src of img is a blob, then treat it as file
      if (!files.length || text || html.match(/<img/g)?.length !== 1 || !/<img[^>]*\s+src=['"]blob:[^>]*>/.test(html)) {
        return false;
      }
      editor.command.image!.insertImages(files);
      return true;
    },
    handleDOMEvents: {
      drop: (editor: SylApi, view: EditorView, e: Event) => {
        const event = e as DragEvent;

        if (view.dragging || (this.props && !this.props.listenDrop) || !event.dataTransfer) {
          return false;
        }
        const files: File[] = getImageFileList(event.dataTransfer.files);
        if (!files.length) return false;
        editor.command.image!.insertImages(files);
        e.preventDefault();
        return true;
      },
    },
  };

  public editorWillUnmount = () => {
    this.editor.root.removeChild(this.fileInput);
  };
}

class Image extends BlockAtom<ImageAttrs> {
  public props: ImageProps;
  public name = PLUGIN_NAME;
  public traceSelection = false;

  constructor(editor: SylApi, props: ImageProps) {
    super(editor, props);
    addAttrsByConfig(props.addAttributes, this);
    this.props = props;

    const { align, alt, ...rest } = this.attrs;
    // @ts-ignore
    this.attrs = { ...rest };
    if (!this.props.disableAlign) this.attrs.align = align;
    if (!this.props.disableCaption) this.attrs.alt = alt;
  }

  public parseDOM = [
    {
      tag: 'div.syl-image-wrapper',
      getAttrs: (dom: HTMLElement) =>
        parseSylDOM(dom, '.syl-image-fixer', '.syl-image-caption', this.props.addAttributes, getMaxWidth(this.editor)),
    },
    {
      tag: 'img',
      getAttrs: (dom: HTMLImageElement) => {
        if (!dom.src) return false;
        const attrWidth = dom.getAttribute('width');
        const attrHeight = dom.getAttribute('height');
        const maxWidth = getMaxWidth(this.editor);

        let width = getPx(dom.style.width || (attrWidth && `${attrWidth}px`) || '', 16);
        let height = getPx(dom.style.height || (attrHeight && `${attrHeight}px`) || '', 16);

        if (!width || isNaN(width)) width = 0;
        if (!height || isNaN(height)) height = 0;

        if (maxWidth && width > maxWidth) {
          if (height) height = height / (width / maxWidth);
          width = maxWidth;
        }

        const formattedAttrs = {
          src: dom.getAttribute('src') || '',
          alt: dom.getAttribute('alt') || '',
          name: dom.getAttribute('name') || '',
          align: (dom.getAttribute('align') || undefined) as any,
          width,
          height,
        };

        getFromDOMByConfig(this.props.addAttributes, dom, formattedAttrs);

        return formattedAttrs;
      },
    },
  ];
  public toDOM = (node: Node) => {
    const { align, width, height, ...attrs } = node.attrs;
    setDOMAttrByConfig(this.props.addAttributes, node, attrs);

    if (width) attrs.width = getFixSize(width);
    if (height) attrs.height = getFixSize(height);

    const renderSpec = ['img', attrs] as DOMOutputSpecArray;
    if (this.inline) return renderSpec;

    const alignAttrs = this.props.disableAlign ? {} : { align: align || 'center' };
    const outputArray = ['div', { class: 'syl-image-wrapper', ...alignAttrs }, renderSpec];
    attrs.alt && outputArray.push(['p', { class: 'syl-image-caption' }, attrs.alt]);
    return (outputArray as unknown) as DOMOutputSpecArray;
  };

  public attrs = {
    src: {
      default: '',
    },
    alt: {
      default: '',
    },
    name: {
      default: '',
    },
    width: {
      default: 0,
    },
    height: {
      default: 0,
    },
    align: {
      default: 'center' as const,
    },
  };
}

class ImagePlugin extends SylPlugin<ImageProps> {
  public name = PLUGIN_NAME;
  public Controller = ImageController;
  public Schema = Image;
}

export { Image, ImageAttrs, ImageController, ImagePlugin, ImageProps };
