type MermaidModule = typeof import("mermaid")

type DiagramDimensions = {
  height: number
  width: number
}

type RenderedDiagram = {
  dimensions: DiagramDimensions
  svg: string
}

let mermaidModule: Promise<MermaidModule> | undefined
let mermaidRenderQueue = Promise.resolve()
let diagramSequence = 0

const renderedDiagramCache = new Map<string, RenderedDiagram>()
const pendingDiagramCache = new Map<string, Promise<RenderedDiagram>>()
const MAX_CACHED_DIAGRAMS = 32

function loadMermaid() {
  mermaidModule ??= import("mermaid").then((module) => {
    module.default.initialize({
      flowchart: { curve: "linear", htmlLabels: true },
      fontFamily:
        '"Berkeley Mono", "SFMono Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      securityLevel: "strict",
      sequence: { actorMargin: 80, diagramMarginX: 16, diagramMarginY: 4 },
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        actorBkg: "#1c1d1f",
        actorBorder: "#444446",
        actorTextColor: "#e3e4e7",
        background: "#19191b",
        fontFamily:
          '"Berkeley Mono", "SFMono Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
        fontSize: "13px",
        labelBoxBkgColor: "#19191b",
        labelBoxBorderColor: "#444446",
        lineColor: "#5c5c5f",
        noteBkgColor: "#1c1d1f",
        noteBorderColor: "#444446",
        noteTextColor: "#e3e4e7",
        primaryBorderColor: "#444446",
        primaryColor: "#1c1d1f",
        primaryTextColor: "#e3e4e7",
        secondaryColor: "#1c1d1f",
        signalColor: "#5c5c5f",
        signalTextColor: "#e3e4e7",
        tertiaryColor: "#1c1d1f",
        textColor: "#e3e4e7",
      },
    })
    return module
  })
  return mermaidModule
}

function diagramDimensions(svg: string): DiagramDimensions {
  const viewBox = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(svg)

  if (!viewBox) {
    return { height: 360, width: 640 }
  }

  const width = Number(viewBox[1])
  const height = Number(viewBox[2])
  return { height, width }
}

function cacheRenderedDiagram(source: string, diagram: RenderedDiagram) {
  renderedDiagramCache.delete(source)
  renderedDiagramCache.set(source, diagram)

  if (renderedDiagramCache.size <= MAX_CACHED_DIAGRAMS) {
    return
  }

  const oldestSource = renderedDiagramCache.keys().next().value
  if (oldestSource) {
    renderedDiagramCache.delete(oldestSource)
  }
}

function renderDiagram(source: string) {
  diagramSequence += 1
  const diagramId = `agent-diagram-${diagramSequence}`
  const render = mermaidRenderQueue.then(() =>
    loadMermaid().then((module) => module.default.render(diagramId, source)),
  )

  mermaidRenderQueue = render.then(
    () => undefined,
    () => undefined,
  )

  return render.then((result) => ({
    dimensions: diagramDimensions(result.svg),
    svg: result.svg,
  }))
}

function getCachedMermaidDiagram(source: string) {
  return renderedDiagramCache.get(source)
}

function preloadMermaidDiagram(source: string) {
  const renderedDiagram = getCachedMermaidDiagram(source)
  if (renderedDiagram) {
    return Promise.resolve(renderedDiagram)
  }

  const pendingDiagram = pendingDiagramCache.get(source)
  if (pendingDiagram) {
    return pendingDiagram
  }

  const render = renderDiagram(source)
    .then((diagram) => {
      cacheRenderedDiagram(source, diagram)
      pendingDiagramCache.delete(source)
      return diagram
    })
    .catch((error: unknown) => {
      pendingDiagramCache.delete(source)
      throw error
    })

  pendingDiagramCache.set(source, render)
  return render
}

export {
  getCachedMermaidDiagram,
  preloadMermaidDiagram,
  type DiagramDimensions,
  type RenderedDiagram,
}
