#!/usr/bin/env node

const express = require('express');
const fs = require('fs');
const path = require('path');

// Key is read from the environment / .env (see src/config.js). Never hardcode it.
const { FIGMA_API_KEY } = require('./src/config');
const { toIR, fileToIR } = require('./src/ir/transform');
const { flattenIR } = require('./src/ir/flatten');
const { prune } = require('./src/prune');
const { tokenize, toTailwindTheme } = require('./src/tokens');
const { componentize } = require('./src/components');

class MCPProxyServer {
  constructor() {
    this.figmaData = null;
    this.svgCache = new Map(); // Cache for SVG exports
  }

  // Parse Figma URL to extract fileId and nodeId
  parseFigmaUrl(url) {
    try {
      const urlObj = new URL(url);
      
      // Extract file ID from path: /design/{fileId}/...
      const pathParts = urlObj.pathname.split('/');
      const fileId = pathParts[2]; // /design/{fileId}/...
      
      // Extract node ID from query params: ?node-id=1648-198101
      const rawNodeId = urlObj.searchParams.get('node-id');
      
      // Convert node ID format from 1648-198101 to 1648:198101 (Figma API format)
      const nodeId = rawNodeId ? rawNodeId.replace('-', ':') : null;
      
      return { fileId, nodeId };
    } catch (error) {
      throw new Error(`Invalid Figma URL: ${error.message}`);
    }
  }

  // Fetch data directly from Figma API
  async fetchFigmaData(fileId) {
    try {
      // Limit the request to avoid "too large" errors
      const params = new URLSearchParams({
        depth: '2', // Limit traversal depth
        geometry: 'paths' // Get geometry but not full path data
      });
      
      const response = await fetch(`https://api.figma.com/v1/files/${fileId}?${params}`, {
        headers: {
          'X-Figma-Token': FIGMA_API_KEY
        }
      });
      
      if (!response.ok) {
        throw new Error(`Figma API error: ${response.status}`);
      }
      
      const data = await response.json();
      // Canonical IR (null-safe colors, no empty objects).
      this.figmaData = fileToIR(data);
      return this.figmaData;
    } catch (error) {
      console.error('Error fetching Figma data:', error);
      throw error;
    }
  }

  // Fetch specific node/component from Figma with full depth.
  // maxDepth (optional) caps how deep the IR tree is built — useful to keep a
  // large section's response compact without resorting to manual decomposition.
  async fetchFigmaComponent(fileId, nodeId, maxDepth) {
    try {
      // First, get the node with deeper structure
      const params = new URLSearchParams({
        ids: nodeId,
        depth: '10', // Get deeper nesting
        geometry: 'paths' // Include geometry data
      });
      
      const response = await fetch(`https://api.figma.com/v1/files/${fileId}/nodes?${params}`, {
        headers: {
          'X-Figma-Token': FIGMA_API_KEY
        }
      });
      
      if (!response.ok) {
        throw new Error(`Figma API error: ${response.status}`);
      }
      
      const data = await response.json();
      const nodeData = data.nodes[nodeId];
      
      if (!nodeData || !nodeData.document) {
        throw new Error(`Node ${nodeId} not found or has no document data`);
      }

      // New canonical IR (null-safe colors, omits empty fields, preserves
      // boundVariables/componentId for later stages).
      return toIR(nodeData.document, typeof maxDepth === 'number' ? { maxDepth } : {});
    } catch (error) {
      console.error('Error fetching Figma component:', error);
      throw error;
    }
  }

  // MCP Protocol Implementation
  async handleRequest(request) {
    const { method, params, id } = request;

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: 'figma-proxy-mcp',
                version: '1.0.0'
              }
            }
          };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'get_figma_file',
                  description: 'Get Figma file data by file ID and transform it for development',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      fileId: {
                        type: 'string',
                        description: 'Figma file ID (from the URL: figma.com/file/{fileId}/...)'
                      }
                    },
                    required: ['fileId']
                  }
                },
                {
                  name: 'get_figma_component',
                  description: 'Get a Figma node by URL. Returns a deterministic, pruned + tokenized + componentized IR with a :root{} CSS-variable block, a Tailwind theme, and a component registry. Colors/spacing/fonts are already resolved to $--var references — the caller does NOT need to re-match raw RGBA against :root. For large sections, call with summary:true FIRST to get a compact { cssVars, tailwindTheme, registry, sections[] } object (top-level children with bounding boxes) WITHOUT the full node tree; this replaces manual get_figma_file decomposition. Then fetch individual sections (optionally with maxDepth) to build them.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      figmaUrl: {
                        type: 'string',
                        description: 'Full Figma URL to a specific node (e.g., https://www.figma.com/design/{fileId}/...?node-id={nodeId})'
                      },
                      summary: {
                        type: 'boolean',
                        description: 'When true, return a compact summary (component meta, CSS vars, Tailwind theme, component registry, and top-level sections with bounding boxes) instead of the full annotated IR tree. Recommended first call for large frames/sections — avoids reading a multi-thousand-line IR.',
                        default: false
                      },
                      maxDepth: {
                        type: 'number',
                        description: 'Cap the IR tree depth (e.g. 3-4) to keep a large section compact without manual decomposition. Omit for full depth.'
                      },
                      minFreq: {
                        type: 'number',
                        description: 'Minimum occurrences for a value to become a design token during tokenization (default 2).',
                        default: 2
                      },
                      prune: {
                        type: 'boolean',
                        description: 'Run the deterministic noise-pruning pass (collapse decorative wrappers, drop invisible/zero-size nodes). Default true; set false for raw IR (debug).',
                        default: true
                      },
                      tokenize: {
                        type: 'boolean',
                        description: 'Run frequency-analysis tokenization: emit :root CSS vars + Tailwind theme and replace raw color/spacing/font values in the IR with $--var references. Default true.',
                        default: true
                      },
                      componentize: {
                        type: 'boolean',
                        description: 'Cluster repeated nodes into a component registry with variant axes and named text styles. Default true.',
                        default: true
                      },
                      lean: {
                        type: 'boolean',
                        description: 'Omit the global blocks (CSS vars, Tailwind theme, component registry) that are identical on every call. Pass true on per-section fetches AFTER the summary call to avoid re-sending ~15KB of duplicated tokens/registry each time. The annotated IR still carries $--var references. Default false.',
                        default: false
                      },
                      format: {
                        type: 'string',
                        enum: ['nested', 'flat'],
                        description: '(non-summary) IR shape. "nested" (default) = full annotated tree. "flat" = a flat array of compact node records (render fields only, coords RELATIVE to the root frame) — much smaller and machine-readable. Use format:"flat" + lean:true for per-section fetches so you NEVER hand-read a deep multi-thousand-line tree.',
                        default: 'nested'
                      }
                    },
                    required: ['figmaUrl']
                  }
                },
                {
                  name: 'export_svg',
                  description: 'Export a specific Figma node as SVG and optionally save it',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      fileId: {
                        type: 'string',
                        description: 'Figma file ID'
                      },
                      nodeId: {
                        type: 'string',
                        description: 'Node ID to export as SVG'
                      },
                      scale: {
                        type: 'number',
                        description: 'Scale factor for export (default: 1)',
                        default: 1
                      },
                      save: {
                        type: 'boolean',
                        description: 'Whether to save the SVG to disk (default: false)',
                        default: false
                      },
                      fileName: {
                        type: 'string',
                        description: 'Custom filename for saved SVG (optional)'
                      },
                      outputDir: {
                        type: 'string',
                        description: 'Output directory for saved SVGs (default: ./exported-svgs)',
                        default: './exported-svgs'
                      }
                    },
                    required: ['fileId', 'nodeId']
                  }
                },
                {
                  name: 'render_node_png',
                  description: 'Export a specific Figma node as PNG and return base64-encoded image data',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      figmaUrl: {
                        type: 'string',
                        description: 'Full Figma URL to a specific node (e.g., https://www.figma.com/design/{fileId}/...?node-id={nodeId})'
                      },
                      fileId: {
                        type: 'string',
                        description: 'Figma file ID (alternative to figmaUrl)'
                      },
                      nodeId: {
                        type: 'string',
                        description: 'Node ID to export (alternative to figmaUrl, use colon format: 133:167)'
                      },
                      scale: {
                        type: 'number',
                        description: 'Scale factor for PNG export (default: 2)',
                        default: 2
                      }
                    }
                  }
                },
                {
                  name: 'migrate_all_svgs',
                  description: 'Automatically find and export all SVG icons from a Figma file',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      fileId: {
                        type: 'string',
                        description: 'Figma file ID to migrate SVGs from'
                      },
                      outputDir: {
                        type: 'string',
                        description: 'Output directory for exported SVGs (default: ./exported-svgs)',
                        default: './exported-svgs'
                      }
                    },
                    required: ['fileId']
                  }
                },
                {
                  name: 'get_cached_components',
                  description: 'Get previously fetched Figma components data',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    required: []
                  }
                },
                {
                  name: 'get_component_by_name',
                  description: 'Get a specific Figma component by name from cached data',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      name: {
                        type: 'string',
                        description: 'Name of the component to find'
                      }
                    },
                    required: ['name']
                  }
                },
                {
                  name: 'list_svg_cache',
                  description: 'List all cached SVG exports',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    required: []
                  }
                },
                {
                  name: 'verify_render',
                  description: 'Visual verification (MEASUREMENT ONLY): render an HTML file with headless Chromium INSIDE this server (does NOT use the user\'s Chrome / Control_Chrome) and compare it to the Figma design PNG. Returns SSIM (0-1, higher = closer), pixel-diff %, and clustered diff regions (bounding boxes of disagreement, in logical px). Provide the reference PNG via figmaUrl (auto-fetched), figmaPngPath, or figmaPngBase64. Use after generating HTML to objectively check fidelity, then fix only the reported regions — this tool never changes code. Requires `npm install` + `npx playwright install chromium`.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      htmlPath: { type: 'string', description: 'Absolute path to the generated .html file to render.' },
                      frameWidth: { type: 'number', description: 'Figma frame width in CSS px (e.g. 1440 or 1920). HTML is rendered at this width.' },
                      figmaUrl: { type: 'string', description: 'Figma node URL — reference PNG fetched automatically at the given scale.' },
                      figmaPngPath: { type: 'string', description: 'Alternative to figmaUrl: local path to an already-saved reference PNG.' },
                      figmaPngBase64: { type: 'string', description: 'Alternative: base64 of the reference PNG.' },
                      scale: { type: 'number', description: 'Device scale factor for render and reference (default 2 — match render_node_png).', default: 2 },
                      threshold: { type: 'number', description: 'SSIM pass threshold (default 0.95).', default: 0.95 },
                      bg: { type: 'array', items: { type: 'number' }, description: 'Background [r,g,b] to flatten transparent reference-PNG pixels onto before comparing. Default [255,255,255]. For dark designs pass the real background (e.g. [13,17,23]) — otherwise transparent areas read as a false full diff.' },
                      clip: { type: 'array', items: { type: 'number' }, description: 'Optional [x,y,w,h] in CSS/logical px to compare ONLY the content area. Use it to exclude dead margins / parent-canvas background that the isolated frame cannot reproduce (that noise otherwise dominates the regions and masks real content diffs). Region coords are reported back in full-frame coords.' },
                      outDir: { type: 'string', description: 'Directory for the diff image (default ./verify-out).', default: './verify-out' }
                    },
                    required: ['htmlPath', 'frameWidth']
                  }
                }
              ]
            }
          };

        case 'tools/call':
          return await this.handleToolCall(params, id);

        case 'notifications/initialized':
          return; // No response needed for notifications

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`
            }
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error.message
        }
      };
    }
  }

  async handleToolCall(params, id) {
    const { name, arguments: args } = params;

    switch (name) {
      case 'get_figma_file':
        const fileId = args?.fileId;
        if (!fileId) {
          throw new Error('Figma file ID is required');
        }

        try {
          const data = await this.fetchFigmaData(fileId);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Figma file data fetched and transformed:\n\n${JSON.stringify(data, null, 2)}`
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error fetching Figma file: ${error.message}\n\nMake sure:\n1. The file ID is correct\n2. The file is public or you have access\n3. The API key is valid`
                }
              ]
            }
          };
        }

      case 'get_figma_component':
        const figmaUrl = args?.figmaUrl;
        if (!figmaUrl) {
          throw new Error('Figma URL is required');
        }

        try {
          const { fileId: componentFileId, nodeId } = this.parseFigmaUrl(figmaUrl);
          
          if (!componentFileId) {
            throw new Error('Could not extract file ID from URL');
          }
          
          if (!nodeId) {
            throw new Error('Could not extract node ID from URL. Make sure the URL contains ?node-id= parameter');
          }

          const maxDepth = args && typeof args.maxDepth === 'number' ? args.maxDepth : undefined;
          const rawIR = await this.fetchFigmaComponent(componentFileId, nodeId, maxDepth);

          // Phase 1: deterministic pruning pass.
          // Pass args.prune = false to skip (debug mode, returns raw IR).
          const skipPrune = args && args.prune === false;
          let prunedIR = rawIR;
          let pruneStats = null;
          if (!skipPrune) {
            const { pruned, stats } = prune(rawIR, { verbose: true });
            prunedIR = pruned;
            pruneStats = stats;
          }

          // Phase 2: tokenisation — frequency analysis → CSS vars + annotated IR.
          // Pass args.tokenize = false to skip.
          const skipTokenize = args && args.tokenize === false;
          let tokenizedIR = prunedIR;
          let cssVars = null;
          let tokenStats = null;
          let tailwindTheme = null;
          if (!skipTokenize) {
            const minFreq = (args && args.minFreq) || 2;
            const result = tokenize(prunedIR, { minFreq, annotate: true, resolveVars: true });
            tokenizedIR = result.annotatedIR;
            cssVars = result.cssVars;
            tokenStats = result.stats;
            tailwindTheme = toTailwindTheme(result.tokenTable);
          }

          // Phase 3: componentization — text styles + component registry.
          // Pass args.componentize = false to skip.
          const skipComponentize = args && args.componentize === false;
          let componentData = tokenizedIR;
          let componentRegistry = null;
          let componentStats = null;
          if (!skipComponentize) {
            const dataDir = path.join(__dirname, 'data');
            const result = componentize(tokenizedIR, {
              dataDir,
              fileId: componentFileId,
              persist: true,
            });
            componentData   = result.annotatedIR;
            componentRegistry = result.registry;
            componentStats  = result.stats;
          }

          // Build response header
          const pruneHeader = pruneStats
            ? `**Prune (Phase 1):** ${pruneStats.before} → ${pruneStats.after} nodes (−${pruneStats.reduction}% | collapsed:${pruneStats.collapsed})`
            : '';
          const tokenHeader = tokenStats
            ? `**Tokens (Phase 2):** ${tokenStats.tokenColors} colors, ${tokenStats.tokenSpacing} spacing, ${tokenStats.fontSizes} font-sizes | varMap:${tokenStats.varMapSize} aliases`
            : '';
          const componentHeader = componentStats
            ? `**Components (Phase 3):** ${componentStats.componentIds} components (${componentStats.variantComponents} with variants) | ${componentStats.textStyles} text styles | ${componentStats.instanceNodes} instances`
            : '';
          const statsBlock = [pruneHeader, tokenHeader, componentHeader].filter(Boolean).join('\n');

          const cssBlock = cssVars
            ? `\n\n**Design Tokens (CSS variables):**\n\`\`\`css\n${cssVars}\n\`\`\``
            : '';

          const registryBlock = componentRegistry
            ? `\n\n**Component Registry:**\n\`\`\`json\n${JSON.stringify(componentRegistry, null, 2)}\n\`\`\``
            : '';

          const tailwindBlock = tailwindTheme
            ? `\n\n**Tailwind Theme (theme.extend):**\n\`\`\`json\n${JSON.stringify(tailwindTheme, null, 2)}\n\`\`\``
            : '';

          // Lean mode: omit the global blocks (CSS vars / Tailwind / registry) that
          // are IDENTICAL on every call for the same file. The agent already has them
          // from the summary call, so re-emitting ~15KB per section fetch is pure
          // duplication. Pass lean:true on per-section fetches after the summary.
          const lean = args && args.lean === true;
          const gCss = lean ? '' : cssBlock;
          const gTw  = lean ? '' : tailwindBlock;
          const gReg = lean ? '' : registryBlock;
          const leanNote = lean
            ? '\n\n_(lean: CSS vars / Tailwind / registry omitted — reuse them from the summary call)_'
            : '';

          // Summary mode: skip full annotated IR, return compact object instead
          const summaryMode = args && args.summary === true;
          if (summaryMode) {
            const rootBox = componentData.box || {
              w: componentData.width,
              h: componentData.height,
              x: componentData.x,
              y: componentData.y,
            };
            const rx = typeof rootBox.x === 'number' ? rootBox.x : 0;
            const ry = typeof rootBox.y === 'number' ? rootBox.y : 0;
            const sections = (componentData.children || []).map((child) => {
              const cb = child.box || { w: child.width, h: child.height, x: child.x, y: child.y };
              const relativeBox = (typeof cb.x === 'number' && typeof cb.y === 'number')
                ? { x: Math.round((cb.x - rx) * 100) / 100, y: Math.round((cb.y - ry) * 100) / 100, w: cb.w, h: cb.h }
                : undefined;
              return {
                id: child.id,
                name: child.name,
                type: child.type,
                box: cb,          // absolute canvas coords (raw)
                relativeBox,      // origin-corrected against root — USE THIS for layout
                childCount: Array.isArray(child.children) ? child.children.length : 0,
                ...(child._componentName ? { _componentName: child._componentName } : {}),
                ...(child._textStyle    ? { _textStyle: child._textStyle }           : {}),
              };
            });

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Figma component (summary mode):\n\n**Component:** ${componentData.name}\n**Type:** ${componentData.type}\n**ID:** ${componentData.id}\n**Root frame box:** x=${rx}, y=${ry}, w=${rootBox.w ?? '?'}, h=${rootBox.h ?? '?'}  (origin = x,y; size = w,h)\n\n${statsBlock}${gCss}${gTw}${gReg}\n\n> For HTML top/left use each section's \`relativeBox\` (already origin-corrected against the root) — NOT the absolute \`box.x/y\`. frameWidth for verify_render = root w (${rootBox.w ?? '?'}).\n\n**Top-level sections (${sections.length}):**\n\`\`\`json\n${JSON.stringify(sections, null, 2)}\n\`\`\``
                  }
                ],
                structuredContent: {
                  component: { name: componentData.name, type: componentData.type, id: componentData.id, box: rootBox },
                  stats: { prune: pruneStats, tokens: tokenStats, components: componentStats },
                  cssVars,
                  tailwindTheme,
                  registry: componentRegistry,
                  sections,
                }
              }
            };
          }

          const flatMode = args && args.format === 'flat';
          let irBlock;
          if (flatMode) {
            const flat = flattenIR(componentData);
            irBlock = `**Flat node list (${flat.length} nodes — \`rel\` = coords relative to root, render fields only; reuse $--var tokens from the summary call):**\n\`\`\`json\n${JSON.stringify(flat)}\n\`\`\``;
          } else {
            irBlock = `**Annotated IR:**\n\`\`\`json\n${JSON.stringify(componentData, null, 2)}\n\`\`\``;
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Figma component fetched successfully:\n\n**Component:** ${componentData.name}\n**Type:** ${componentData.type}\n**ID:** ${componentData.id}\n\n${statsBlock}${gCss}${gTw}${gReg}${leanNote}\n\n${irBlock}`
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error fetching Figma component: ${error.message}\n\nMake sure:\n1. The URL is a valid Figma design URL\n2. The URL contains node-id parameter\n3. You have access to the file\n4. The component exists\n\nExample URL format:\nhttps://www.figma.com/design/{fileId}/...?node-id={nodeId}`
                }
              ]
            }
          };
        }

      case 'export_svg':
        const { fileId: svgFileId, nodeId: svgNodeId, scale = 1, save = false, fileName, outputDir = './exported-svgs' } = args;
        
        if (!svgFileId || !svgNodeId) {
          throw new Error('Both fileId and nodeId are required');
        }

        try {
          const svgContent = await this.exportSVG(svgFileId, svgNodeId, scale);
          
          let result = {
            nodeId: svgNodeId,
            svgContent: svgContent,
            size: svgContent.length
          };
          
          if (save) {
            const name = fileName || `node_${svgNodeId}`;
            const filePath = await this.saveSVG(svgContent, name, outputDir);
            result.savedTo = filePath;
          }
          
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `SVG exported successfully:\n\n**Node ID:** ${svgNodeId}\n**Size:** ${result.size} characters\n${result.savedTo ? `**Saved to:** ${result.savedTo}\n` : ''}**Scale:** ${scale}\n\n**SVG Content Preview (first 500 chars):**\n\`\`\`svg\n${svgContent.substring(0, 500)}${svgContent.length > 500 ? '...' : ''}\n\`\`\``
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error exporting SVG: ${error.message}\n\nMake sure:\n1. The file ID and node ID are correct\n2. The node can be exported as SVG\n3. You have access to the file`
                }
              ]
            }
          };
        }

      case 'render_node_png': {
        // Accept either figmaUrl OR {fileId, nodeId}
        let pngFileId, pngNodeId;
        if (args && args.figmaUrl) {
          const parsed = this.parseFigmaUrl(args.figmaUrl);
          pngFileId = parsed.fileId;
          pngNodeId = parsed.nodeId;
        } else {
          pngFileId = args && args.fileId;
          pngNodeId = args && args.nodeId;
        }
        const pngScale = (args && args.scale) || 2;

        if (!pngFileId || !pngNodeId) {
          throw new Error('figmaUrl (or fileId + nodeId) is required for render_node_png');
        }

        try {
          const { imageUrl, base64, size } = await this.exportPNG(pngFileId, pngNodeId, pngScale);

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `PNG exported successfully:\n\n**Node ID:** ${pngNodeId}\n**Scale:** ${pngScale}x\n**Size:** ${size} bytes\n**Image URL:** ${imageUrl}\n\n**Base64 (data URI):**\ndata:image/png;base64,${base64.substring(0, 80)}...`
                }
              ],
              structuredContent: {
                nodeId: pngNodeId,
                imageUrl,
                base64,
                size,
                scale: pngScale,
              }
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error exporting PNG: ${error.message}\n\nMake sure:\n1. The file ID and node ID are correct\n2. You have access to the file`
                }
              ]
            }
          };
        }
      }

      case 'migrate_all_svgs':
        const { fileId: migrateFileId, outputDir: migrateOutputDir = './exported-svgs' } = args;
        
        if (!migrateFileId) {
          throw new Error('File ID is required');
        }

        try {
          const results = await this.migrateAllSVGs(migrateFileId, migrateOutputDir);
          const successful = results.filter(r => r.success);
          const failed = results.filter(r => !r.success);
          
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `SVG Migration Complete!\n\n**Summary:**\n- Total nodes processed: ${results.length}\n- Successfully exported: ${successful.length}\n- Failed: ${failed.length}\n- Output directory: ${migrateOutputDir}\n\n**Successful exports:**\n${successful.map(r => `✅ ${r.name} → ${r.filePath}`).join('\n')}\n\n${failed.length > 0 ? `**Failed exports:**\n${failed.map(r => `❌ ${r.name}: ${r.error}`).join('\n')}` : ''}\n\n**Detailed Results:**\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\``
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error migrating SVGs: ${error.message}\n\nMake sure:\n1. The file ID is correct\n2. You have access to the file\n3. The output directory is writable`
                }
              ]
            }
          };
        }

      case 'list_svg_cache':
        const cacheEntries = Array.from(this.svgCache.entries()).map(([nodeId, content]) => ({
          nodeId,
          size: content.length,
          preview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
        }));
        
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: cacheEntries.length > 0 ? 
                  `Cached SVG exports (${cacheEntries.length}):\n\n${cacheEntries.map(entry => `**${entry.nodeId}**: ${entry.size} chars\n\`${entry.preview}\`\n`).join('\n')}` :
                  'No SVG exports cached yet.'
              }
            ]
          }
        };

      case 'get_cached_components':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: this.figmaData ? 
                  `Cached Figma components:\n\n${JSON.stringify(this.figmaData, null, 2)}` :
                  'No Figma data cached yet. Use get_figma_file first with a file ID.'
              }
            ]
          }
        };

      case 'get_component_by_name':
        const componentName = args?.name;
        if (!componentName) {
          throw new Error('Component name is required');
        }

        if (!this.figmaData) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: 'No Figma data cached yet. Use get_figma_file first with a file ID.'
                }
              ]
            }
          };
        }

        const component = this.figmaData?.find(comp => 
          comp.name?.toLowerCase().includes(componentName.toLowerCase())
        );

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: component ? 
                  `Found component "${componentName}":\n\n${JSON.stringify(component, null, 2)}` :
                  `No component found with name containing "${componentName}"`
              }
            ]
          }
        };

      case 'verify_render': {
        const { verifyRender } = require('./src/visual/verify');
        const vHtmlPath = args && args.htmlPath;
        const vFrameWidth = args && args.frameWidth;
        if (!vHtmlPath || !vFrameWidth) {
          throw new Error('verify_render requires htmlPath and frameWidth');
        }
        const vScale = (args && args.scale) || 2;
        const vThreshold = (args && typeof args.threshold === 'number') ? args.threshold : 0.95;
        const vOutDir = (args && args.outDir) || path.join(__dirname, 'verify-out');

        try {
          // Resolve the reference PNG buffer
          let referencePngBuffer;
          if (args.figmaUrl) {
            const { fileId: vFileId, nodeId: vNodeId } = this.parseFigmaUrl(args.figmaUrl);
            const { base64 } = await this.exportPNG(vFileId, vNodeId, vScale);
            referencePngBuffer = Buffer.from(base64, 'base64');
          } else if (args.figmaPngPath) {
            referencePngBuffer = fs.readFileSync(args.figmaPngPath);
          } else if (args.figmaPngBase64) {
            referencePngBuffer = Buffer.from(args.figmaPngBase64, 'base64');
          } else {
            throw new Error('Provide a reference PNG: figmaUrl, figmaPngPath, or figmaPngBase64');
          }

          const label = path.basename(vHtmlPath).replace(/\.html?$/i, '');
          const result = await verifyRender({
            htmlPath: vHtmlPath,
            referencePngBuffer,
            frameWidth: vFrameWidth,
            scale: vScale,
            threshold: vThreshold,
            outDir: vOutDir,
            label,
            bg: Array.isArray(args.bg) ? args.bg : undefined,
            clip: Array.isArray(args.clip) ? args.clip : undefined,
          });

          const regions = result.diffRegions.map((r, i) =>
            `  ${i + 1}. [${r.type}] (${r.x},${r.y}) ${r.w}×${r.h} — render ${r.renderColor} vs design ${r.refColor} (Δ${r.colorDelta}), ${r.diffPixels}px`).join('\n')
            || '  (no regions above threshold)';

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Visual verification — ${label}:\n\n**SSIM:** ${result.ssim} (threshold ${result.threshold} → ${result.pass ? 'PASS ✅' : 'BELOW ❌'})\n**Pixel diff:** ${result.pixelDiffPct}% (${result.diffPixels} px of ${result.dims.w}×${result.dims.h})\n**Diff image:** ${result.diffImagePath || '(not saved)'}\n\n**Diff regions (logical px, largest first):**\n${regions}\n\nRead the regions and fix only those areas — this tool does not change code.`
                }
              ],
              structuredContent: result,
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                { type: 'text', text: `Error in verify_render: ${error.message}\n\nIf this mentions playwright, run \`npm install\` in proxy-mcp and \`npx playwright install chromium\`.` }
              ]
            }
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // Export SVG from Figma node
  async exportSVG(fileId, nodeId, scale = 1) {
    try {
      const params = new URLSearchParams({
        ids: nodeId,
        format: 'svg',
        scale: scale.toString()
      });
      
      const response = await fetch(`https://api.figma.com/v1/images/${fileId}?${params}`, {
        headers: {
          'X-Figma-Token': FIGMA_API_KEY
        }
      });
      
      if (!response.ok) {
        throw new Error(`Figma API error: ${response.status}`);
      }
      
      const data = await response.json();
      const svgUrl = data.images[nodeId];
      
      if (!svgUrl) {
        throw new Error('No SVG URL returned from Figma API');
      }
      
      // Fetch the actual SVG content
      const svgResponse = await fetch(svgUrl);
      if (!svgResponse.ok) {
        throw new Error(`Failed to fetch SVG content: ${svgResponse.status}`);
      }
      
      const svgContent = await svgResponse.text();
      
      // Cache the SVG
      this.svgCache.set(nodeId, svgContent);
      
      return svgContent;
    } catch (error) {
      console.error('Error exporting SVG:', error);
      throw error;
    }
  }

  // Export PNG from Figma node — returns { imageUrl, base64, size }
  async exportPNG(fileId, nodeId, scale = 2) {
    try {
      const params = new URLSearchParams({
        ids: nodeId,
        format: 'png',
        scale: scale.toString(),
      });

      const response = await fetch(`https://api.figma.com/v1/images/${fileId}?${params}`, {
        headers: { 'X-Figma-Token': FIGMA_API_KEY },
      });

      if (!response.ok) {
        throw new Error(`Figma API error: ${response.status}`);
      }

      const data = await response.json();

      // Figma returns { images: { [nodeId]: url } }
      // The nodeId key in the response uses the original format from the request
      const imageUrl = data.images && (data.images[nodeId] || Object.values(data.images)[0]);

      if (!imageUrl) {
        throw new Error('No PNG URL returned from Figma API');
      }

      // Download the PNG and convert to base64
      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) {
        throw new Error(`Failed to fetch PNG: ${imgResponse.status}`);
      }

      const arrayBuffer = await imgResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString('base64');

      return { imageUrl, base64, size: buffer.length };
    } catch (error) {
      console.error('Error exporting PNG:', error);
      throw error;
    }
  }

  // Save SVG to file system
  async saveSVG(svgContent, fileName, outputDir = './exported-svgs') {
    try {
      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      // Clean filename
      const cleanFileName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const filePath = path.join(outputDir, `${cleanFileName}.svg`);
      
      fs.writeFileSync(filePath, svgContent, 'utf8');
      
      return filePath;
    } catch (error) {
      console.error('Error saving SVG:', error);
      throw error;
    }
  }

  // Migrate all SVG icons from a Figma file
  async migrateAllSVGs(fileId, outputDir = './exported-svgs') {
    try {
      const figmaData = await this.fetchFigmaData(fileId);
      const svgNodes = this.findSVGNodes(figmaData);
      const results = [];
      
      for (const node of svgNodes) {
        try {
          const svgContent = await this.exportSVG(fileId, node.id);
          const filePath = await this.saveSVG(svgContent, node.name, outputDir);
          
          results.push({
            nodeId: node.id,
            name: node.name,
            filePath: filePath,
            success: true
          });
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          results.push({
            nodeId: node.id,
            name: node.name,
            error: error.message,
            success: false
          });
        }
      }
      
      return results;
    } catch (error) {
      console.error('Error migrating SVGs:', error);
      throw error;
    }
  }

  // Find potential SVG nodes in Figma data
  findSVGNodes(data) {
    const svgNodes = [];
    
    const traverseNode = (node) => {
      // Check if node could be an icon/SVG
      if (node && (
        node.type === 'VECTOR' ||
        node.type === 'BOOLEAN_OPERATION' ||
        (node.name && node.name.toLowerCase().includes('icon')) ||
        (node.name && node.name.toLowerCase().includes('svg')) ||
        (node.exportSettings && node.exportSettings.some(s => s.format === 'SVG'))
      )) {
        svgNodes.push({
          id: node.id,
          name: node.name,
          type: node.type
        });
      }
      
      // Recursively check children (canonical IR uses `children`)
      const kids = node.children || node.childrenData;
      if (Array.isArray(kids)) {
        kids.forEach(traverseNode);
      }
    };
    
    if (Array.isArray(data)) {
      data.forEach(traverseNode);
    } else {
      traverseNode(data);
    }
    
    return svgNodes;
  }
}

// Handle stdio communication (what Cursor uses)
if (process.argv.includes('--stdio')) {
  const server = new MCPProxyServer();
  
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (data) => {
    const lines = data.trim().split('\n');
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const request = JSON.parse(line);
          const response = await server.handleRequest(request);
          if (response) {
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        } catch (error) {
          console.error('Error processing request:', error);
        }
      }
    }
  });

  process.on('SIGINT', () => {
    process.exit(0);
  });

  console.error('Figma Proxy MCP Server started in stdio mode');
} else {
  // HTTP mode for testing
  const app = express();
  const port = 4444;
  const server = new MCPProxyServer();

  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    try {
      const response = await server.handleRequest(req.body);
      if (response) {
        res.json(response);
      } else {
        res.status(204).send();
      }
    } catch (error) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body.id,
        error: {
          code: -32603,
          message: error.message
        }
      });
    }
  });

    app.listen(port, () => {
    console.log(`🔁 Figma Proxy MCP Server running at http://localhost:${port}/mcp`);
    console.log('For Cursor integration, use: node proxy-mcp.js --stdio');
  });
}

// Export for testing
module.exports = { MCPProxyServer };