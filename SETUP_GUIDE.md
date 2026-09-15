# Media Velocity Engine - ByteDance POC Setup Guide

## Overview
This is a proof-of-concept (POC) demonstrating a **Retrieval-Augmented Generation (RAG) system** powered by BytePlus/Volcano Engine for a VFX studio. The system retrieves historical 3D assets using vector similarity search and generates production-ready pipeline code using DeepSeek-V4-Flash LLM.

**Key Technologies:**
- **Frontend:** Streamlit (dark-themed, modern UI)
- **Vector Database:** Pinecone
- **Code Generation LLM:** DeepSeek-V4-Flash (via BytePlus API)
- **Generative Models:** Seedream-5.0 + Dreamina Seedance-2.0 (via BytePlus API)
- **Local Embeddings:** sentence-transformers (no external API needed)
- **Environment:** Python 3.10+

---

## architecture

### System Components

1. **RAG Engine (`rag_engine.py`)**
   - Manages Pinecone vector database queries
   - Uses local sentence-transformers for embeddings (384-dim)
   - Calls BytePlus API with DeepSeek-V4-Flash for code generation
   - Supports streaming output for real-time display

2. **Generative API (`byteplus_generative.py`)**
   - Interfacs with BytePlus Volcano Engine
   - Implements Seedream-5.0 for concept art and character sheet generation
   - Generates JSON payloads for 3D/texture generation
   - Simulates realistic API responses with proper metadata

3. **Database Setup (`setup_db.py`)**
   - Initializes Pinecone index (384-dim, cosine metric)
   - Creates 10 mock VFX studio assets
   - Embeds assets using local sentence-transformers
   - Upserts embeddings to Pinecone without API latency

4. **Streamlit UI (`app.py`)**
   - Tab 1: Studio RAG - Query assets and generate code
   - Tab 2: Pre-Production Generation - Test Dola-Seed parameters
   - Tab 3: System Information - Configuration display

---

## Prerequisites

### Required Accounts & Access

1. **BytePlus/Volcano Engine:**
   - Active BytePlus account with provisioned API access
   - `BYTEPLUS_API_KEY` from console.byteplus.com
   - Access to models: `deepseek-v4-flash-260425`, `seedream-5-0-260128`, `dreamina-seedance-2-0-260128`
   - Note: Models must be enabled in your BytePlus account

2. **Pinecone:**
   - Active Pinecone account
   - `PINECONE_API_KEY` from console.pinecone.io
   - Must be in the same tier/region for the POC

3. **Python Environment:**
   - Python 3.10 or newer
   - pip or conda for package management

---

## Installation & Setup

### Step 1: Clone/Download Repository
```bash
# Navigate to project directory
cd "d:\BYTEDANCE DEMO"
```

### Step 2: Create & Activate Python Environment
```bash
# Create virtual environment
python -m venv venv

# Activate (Windows)
venv\Scripts\activate

# Activate (macOS/Linux)
source venv/bin/activate
```

### Step 3: Install Dependencies
```bash
# Install all required packages
pip install -r requirements.txt

# Key packages:
# - streamlit==1.28.1 (UI framework)
# - pinecone-client==3.0.0 (vector database)
# - openai==1.18.0 (OpenAI-compatible client for BytePlus)
# - sentence-transformers==2.2.2 (local embeddings)
# - torch==2.1.0 (embedding model backend)
```

### Step 4: Configure Environment Variables
```bash
# Copy example config
cp .env.example .env

# Edit .env with your credentials
# REQUIRED:
BYTEPLUS_API_KEY=your-key-here
PINECONE_API_KEY=your-key-here
```

### Step 5: Initialize Pinecone Vector Database
```bash
# This creates the index and populates it with 10 mock assets
python setup_db.py

# Output should show:
# ✓ Index 'studio-assets' created/verified
# ✓ 10 mock assets embedded and upserted
# ✓ Ready for RAG queries
```

### Step 6: Start Streamlit Application
```bash
# Launch the UI (opens in browser at localhost:8501)
streamlit run app.py
```

---

## Usage Guide

### Tab 1: Studio RAG (Asset Revival System)

**Purpose:** Retrieve historical VFX studio assets and generate production-ready code.

**Workflow:**

1. **Enter Request:**
   - Type or select a predefined query
   - Example: "I need a rusty metal shader for a sci-fi robot"

2. **Select Pipeline:**
   - Choose target application: Maya, Houdini, Nuke, or Blender
   - Code will be optimized for the selected DCC

3. **Advanced Options (Optional):**
   - Adjust number of assets to retrieve (1-10)
   - Enable streaming output for real-time code display

4. **Click "Search Studio Assets":**
   - System queries Pinecone using semantic search
   - DeepSeek-V4-Flash generates contextual pipeline code
   - Retrieved assets and code displayed in real-time

**Output:**
- ✅ 3 most similar historical assets (with similarity scores)
- ✅ Production-ready Python code for the selected DCC
- ✅ Token usage statistics
- ✅ Workflow metadata

---

### Tab 2: Pre-Production Generation

**Purpose:** Test BytePlus generative AI models for 3D and texture generation.

#### 3D Mesh Generation Sub-tab

1. **Enter 3D Prompt:**
   - Describe desired 3D model
   - Example: "A futuristic cyberpunk spaceship with intricate details"

2. **Configure Parameters:**
   - **Quality:** low/medium/high/ultra (affects polygon count)
   - **Style:** photorealism/stylized/abstract

3. **Click "Generate Mesh Parameters":**
   - Seedream-5.0 generates concept art images
   - Shows mesh specifications (vertex/triangle counts)
   - Displays material setup, rigging parameters, export paths

**Output:**
- JSON payload with 3D generation parameters
- Material presets and texture resolutions
- Rigging hints and export configurations
- Simulated job metadata and performance metrics

#### Texture Generation Sub-tab

1. **Enter Texture Prompt:**
   - Describe desired texture
   - Example: "Rough industrial metal with rust streaks"

2. **Configure Parameters:**
   - **Material Type:** pbr/specular/metallic
   - **Resolution:** 512/1k/2k/4k/8k

3. **Click "Generate Texture Parameters":**
   - Generates PBR texture configuration
   - Shows material properties and map specifications
   - Provides export paths for all texture maps

**Output:**
- JSON payload with texture parameters
- PBR map specifications and resolutions
- Material properties (roughness, metallic, normal strength)
- Simulated rendering time and compute costs

---

### Tab 3: System Information

Displays:
- ✅ Current BytePlus configuration
- ✅ Pinecone index details
- ✅ Supported features and models
- ✅ Technology stack overview

---

## API Integration Details

### BytePlus API Configuration

The application uses the OpenAI-compatible SDK with BytePlus endpoint:

```python
from openai import OpenAI

client = OpenAI(
    api_key=os.getenv("BYTEPLUS_API_KEY"),
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3"
)

# Call DeepSeek-V4-Flash for code generation
response = client.chat.completions.create(
    model="deepseek-v4-flash-260425",
    messages=[...],
    temperature=0.7,
    max_tokens=2000
)
```

### Models Used

1. **deepseek-v4-flash-260425**
   - Purpose: Generate production-ready VFX pipeline code
   - Context: RAG assets + artist request
   - Temperature: 0.7 (creative but consistent)
   - Max tokens: 2000

2. **seedream-5-0-260128**
   - Purpose: Concept art and character sheet generation
   - Context: Text prompt + quality/style preferences
   - Temperature: 0.7
   - Output: JSON payloads with generation parameters

### Embedding Models

- **Local**: `sentence-transformers/all-MiniLM-L6-v2`
- Dimension: 384
- Advantage: No API calls, instant embedding, cost-effective
- Used for Pinecone vector similarity search

---

## Pinecone Index Structure

**Index Name:** `studio-assets`
**Dimension:** 384 (sentence-transformers)
**Metric:** cosine similarity
**Capacity:** Serverless on AWS

**Metadata Fields per Document:**
- `asset_id`: Unique identifier (e.g., "ASSET_001")
- `asset_name`: Human-readable name
- `asset_type`: shader/texture/model/effect
- `project_year`: Historical context (2021-2024)
- `description`: Rich text description for context

---

## Mock Assets (Included in POC)

10 predefined VFX studio assets are included:

1. Rusty Sci-Fi Metal Shader
2. Damaged Concrete Wall 4K
3. Hero Character Base Mesh
4. Neon Glow Post-Process
5. Procedural Water Surface
6. Abandoned Factory Interior
7. Alien Skin Material
8. Wood Floor Weathered
9. Energy Shield Effect
10. Medieval Stone Masonry

---

## Troubleshooting

### Issue: "No assets found" in RAG Tab

**Solution:**
1. Ensure setup_db.py has been run successfully
2. Check Pinecone index exists: `python -c "from pinecone import Pinecone; p = Pinecone(api_key='...'); print(p.list_indexes())"`
3. Verify index is populated: `index.describe_index_stats()`

### Issue: BytePlus API Error (401/403)

**Solution:**
1. Verify BYTEPLUS_API_KEY in .env is correct
2. Check that models (deepseek-v4-flash-260425, seedream-5-0-260128, dreamina-seedance-2-0-260128) are enabled in your BytePlus account
3. Confirm account has active subscription/credits
4. Test API connectivity: `python -c "from openai import OpenAI; ..."`

### Issue: Pinecone Connection Error

**Solution:**
1. Verify PINECONE_API_KEY and PINECONE_INDEX_NAME in .env
2. Check network connectivity to Pinecone servers
3. Ensure index exists in Pinecone console
4. Rebuild index if needed: `python setup_db.py`

### Issue: Embedding Model Not Loading

**Solution:**
1. Ensure torch and sentence-transformers are installed: `pip install torch sentence-transformers`
2. First run will download the model (~100MB) - requires internet
3. Check disk space in `~/.cache/huggingface/hub/`

### Issue: Streamlit Port Already In Use

**Solution:**
```bash
# Use different port
streamlit run app.py --server.port 8502
```

---

## Development & Customization

### Adding New Assets to RAG

Edit `setup_db.py`, add to `generate_mock_assets()`:

```python
{
    "asset_id": "ASSET_011",
    "asset_name": "Your Asset Name",
    "asset_type": "shader/texture/model",
    "project_year": 2024,
    "description": "Rich detailed description for semantic search..."
}
```

Then re-run: `python setup_db.py`

### Modifying Code Generation Prompts

Edit `rag_engine.py`, `generate_pipeline_code()` method:

```python
system_prompt = """Custom system prompt..."""
user_message = f"""Customized generation context..."""
```

### Adjusting Embedding Model

In `rag_engine.py` and `setup_db.py`, change:

```python
self.embedding_model = SentenceTransformer("your-model-here")
self.embedding_dim = 768  # Adjust dimension as needed
```

Then recreate Pinecone index with new dimension.

---

## Performance Metrics

### Typical Response Times

- **Semantic Search (Pinecone):** 100-200ms
- **Code Generation (DeepSeek-V4-Flash via BytePlus):** 1-4 seconds
- **Parameter Generation (Dola-Seed):** 1-3 seconds
- **Local Embedding:** 10-50ms

### Compute Costs

- Local embeddings: Free (no API calls)
- DeepSeek-V4-Flash inference: Varies by token count (~5000 tokens typical)
- Dola-Seed generation: Varies by complexity
- Pinecone storage: Based on index size and queries

---

## Production Deployment Notes

For deployment to production VFX pipelines:

1. **Security:**
   - Store BYTEPLUS_API_KEY in secure vault (not hardcoded)
   - Use service account for API calls
   - Implement rate limiting

2. **Scalability:**
   - Use Pinecone serverless for auto-scaling
   - Consider caching frequent queries
   - Implement job queuing for bulk asset generation

3. **Monitoring:**
   - Log all API calls with timestamps
   - Monitor BytePlus quota usage
   - Track Pinecone query performance

4. **Integration:**
   - Expose as REST API (FastAPI/Flask) instead of Streamlit
   - Integrate with DCC plugins (Maya, Houdini, etc.)
   - Connect to asset management systems (Shotgun, Airtable)

---

## Support & Documentation

- **BytePlus Docs:** https://console.byteplus.com/docs
- **Pinecone Docs:** https://docs.pinecone.io
- **Streamlit Docs:** https://docs.streamlit.io
- **OpenAI SDK:** https://github.com/openai/openai-python

---

## License & Attribution

This POC was created for ByteDance interview demonstration purposes.

- BytePlus/Volcano Engine: ByteDance proprietary
- Pinecone: https://www.pinecone.io
- Streamlit: https://streamlit.io
- sentence-transformers: https://www.sbert.net
- OpenAI Python SDK: https://github.com/openai/openai-python

---

**Last Updated:** March 25, 2026  
**Version:** 1.0.0 (POC)
