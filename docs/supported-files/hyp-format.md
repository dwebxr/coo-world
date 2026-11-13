# .hyp File Format Documentation

The `.hyp` file format is a custom binary format used for Hyperfy Apps that bundles a blueprint configuration with its associated assets.

## File Structure

A `.hyp` file consists of three main sections:

1. Header Size (4 bytes)
   - Uint32 value (little-endian) indicating the size of the header JSON in bytes

2. Header (JSON)
   - Contains two main objects:
     - `blueprint`: The app configuration
     - `assets`: Metadata for all bundled assets

3. Asset Data
   - Raw binary data of all assets concatenated sequentially

## Header Format

The header is a JSON object with the following structure:

```json
{
  "blueprint": {
    "name": "string",
    "model": "string (optional)",
    "script": "string (optional)",
    "props": {
      [key: string]: {
        "type": "string",
        "url": "string"
      }
    },
    "frozen": "boolean"
  },
  "assets": [
    {
      "type": "model | avatar | script",
      "url": "string",
      "size": "number",
      "mime": "string"
    }
  ]
}
```

### Blueprint Properties

- `name`: The name of the app (used for the output filename if not specified)
- `model`: (Optional) URL of the main 3D model file: `asset://<name>` (one file in the world's asset store; the name has letters, digits, `.`, `_` and `-`, up to 128 characters) or an `http(s)://` URL
- `script`: (Optional) URL of the app's script file, in the same two forms. A world refuses an app whose `model`, `script` or `image.url` is anything else (a file path, `asset://../…`, `file:`, `data:` and other schemes)
- `props`: Object containing additional properties with associated assets
- `frozen`: Boolean flag indicating if the app is locked/frozen

### Asset Types

Assets can be of different types:
- `model`: 3D model files (e.g., .glb)
- `avatar`: VRM avatar files
- `script`: JavaScript files

## File Operations

### Exporting

When creating a .hyp file:
1. The blueprint is cloned
2. All assets are collected from:
   - Main model file
   - Script file
   - Props with URLs
3. Header is created with blueprint and asset metadata
4. Header size is written as first 4 bytes
5. Header JSON is converted to bytes and written
6. All asset files are appended sequentially

### Importing

When reading a .hyp file:
1. First 4 bytes are read to determine header size
2. Header JSON is parsed from the next bytes
3. Remaining bytes are split into individual asset files based on size metadata
4. Returns an object containing:
   - The blueprint configuration
   - Array of asset files with their metadata

An asset whose `url` is the address of an uploaded file, `asset://<sha256 of its bytes>.<ext>`, must hold exactly those bytes or the whole file is refused, and only such assets are cached by the client of the builder who drops the file and uploaded; any other `url` (a built-in such as `asset://ai.glb`, an `http(s)://` URL) stays in the blueprint and loads from its own address, as for everyone else. A `.hyp` file is still code: its blueprint's script runs with an app's powers once the builder adds it.

## Usage Example

```javascript
// Export a .hyp file
const hypFile = await exportApp(blueprint, resolveFile)

// Import a .hyp file
const { blueprint, assets } = await importApp(hypFile)
```

## Binary Format Specification

```
[Header Size (4 bytes)][Header JSON (variable size)][Asset1 Data][Asset2 Data]...
```

The format uses little-endian encoding for the header size value.
