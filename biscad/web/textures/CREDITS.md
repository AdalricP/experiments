# Texture credits

All textures are CC0 (public domain). No attribution is required. We list the sources anyway.

| Folder | Source asset | Site | Maps used |
|---|---|---|---|
| `brushed_metal/` | Metal 010 (`Metal010`) | [ambientCG](https://ambientcg.com/view?id=Metal010) | NormalGL; Roughness (R) + Color luminance (G) in `surface.jpg` |
| `powder_grain/` | Clean Asphalt (`clean_asphalt`) | [Poly Haven](https://polyhaven.com/a/clean_asphalt) | nor_gl; rough (R) + ao (G) in `surface.jpg` |
| `worn_concrete/` | Concrete Floor Worn 001 (`concrete_floor_worn_001`) | [Poly Haven](https://polyhaven.com/a/concrete_floor_worn_001) | nor_gl; rough (R) + ao (G) in `surface.jpg` |

All maps are 1024 × 1024 px JPG. `js/surface.js` blends the three sets with hex-tile sampling and tints them blood red.
