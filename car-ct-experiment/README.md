# Hill climb: open-loop vs closed-loop control

A small Pygame comparison of two cars going along a `_ /` road. The orange car uses a fixed throttle, while the teal car adjusts its throttle with a PI feedback controller to maintain a selected speed as the hill steepness changes. Use `W`/`S` for the open-loop input, arrow keys for the closed-loop speed target, brackets for steepness, `F` for flat terrain, and `R` to reset.

```sh
python3 hill_climb.py
SDL_VIDEODRIVER=dummy python3 hill_climb.py --capture assets/hill-climb-dashboard.png
```
