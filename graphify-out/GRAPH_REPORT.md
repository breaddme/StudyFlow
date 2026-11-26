# Graph Report - physic  (2026-11-26)

## Corpus Check
- Corpus is ~0 words - fits in a single context window. You may not need a graph.

## Summary
- 101 nodes · 179 edges · 6 communities
- Extraction: 85% EXTRACTED · 15% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Traveling Waves & Standing Interference
- Thermodynamics, Gas Laws & Heat Engines
- Oscillations, SHM & Resonance
- Hydrostatics, Pressure & Buoyancy
- Fluid Dynamics, Bernoulli & Viscosity
- Doppler Effect & Shock Waves

## God Nodes (most connected - your core abstractions)
1. `SCPY130 EP9 Part 1: Fluids (Hydrostatics and Pascal's Principle)` - 15 edges
2. `SCPY130 EP9 Part 2: Fluids (Buoyancy, Fluid Dynamics and Viscosity)` - 15 edges
3. `First Law of Thermodynamics (Delta E_int = Q - W)` - 10 edges
4. `SCPY130 EP7 Part 1: Oscillations Slides` - 8 edges
5. `SCPY130 EP7 Part 2: Oscillations Slides` - 8 edges
6. `Pressure at Depth (p = p0 + rho g h)` - 8 edges
7. `Bernoulli's Equation` - 8 edges
8. `SCPY130 EP8 Part 1: Traveling Waves` - 6 edges
9. `Standing Waves` - 6 edges
10. `Carnot Cycle (Two Isothermal + Two Adiabatic Steps)` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Powerbuoy Renewable Wave Energy (Fig. 16.1)` --conceptually_related_to--> `Average Power in a String Wave (P_ave)`  [INFERRED]
  SCPY130 EP8-part1.pdf → SCPY130 EP8-part2.pdf
- `Wave Speed Relation (v = lambda / T = lambda f)` --conceptually_related_to--> `The Doppler Effect (Sec. 17.7)`  [INFERRED]
  SCPY130 EP8-part1.pdf → SCPY130 EP8-part3.pdf
- `Wave Speed on a Stretched String` --conceptually_related_to--> `Normal Modes & Symmetric Boundary Conditions`  [INFERRED]
  SCPY130 EP8-part1.pdf → SCPY130 EP8-part2.pdf
- `Prandtl (Pitot) Tube Velocity Measurement` --conceptually_related_to--> `Open U-Tube Manometer`  [INFERRED]
  SCPY130 EP9-part2.pdf → SCPY130 EP9-part1.pdf
- `Comcast Building Tuned Liquid-Column Mass Damper` --conceptually_related_to--> `Resonance and Damping Bandwidth Curve`  [INFERRED]
  SCPY130 EP7-part1.pdf → SCPY130 EP7-part2.pdf

## Hyperedges (group relationships)
- **Simple Harmonic Motion Core Framework** — scpy130_ep7_part1_simple_harmonic_motion, scpy130_ep7_part1_hookes_law_restoring_force, scpy130_ep7_part1_shm_kinematic_equations, scpy130_ep7_part1_mass_spring_oscillator, scpy130_ep7_part2_shm_mechanical_energy [EXTRACTED 1.00]
- **Pendulum Models and Applications** — scpy130_ep7_part1_simple_pendulum, scpy130_ep7_part1_physical_pendulum, scpy130_ep7_part2_pendulum_gravity_measurement, scpy130_ep7_part2_skyscraper_physical_pendulum [INFERRED 0.95]
- **Damped and Forced Oscillation Dynamics** — scpy130_ep7_part2_damped_oscillations, scpy130_ep7_part2_damping_regimes, scpy130_ep7_part2_forced_oscillations, scpy130_ep7_part2_resonance_curve, scpy130_ep7_part1_comcast_tuned_mass_damper [INFERRED 0.85]
- **Wave Kinematics & Medium Wave Speeds** — scpy130_ep8_part1_traveling_waves, scpy130_ep8_part1_wave_speed_relation, scpy130_ep8_part1_periodic_wave_equation, scpy130_ep8_part1_wave_number, scpy130_ep8_part1_linear_mass_density, scpy130_ep8_part1_string_wave_speed, scpy130_ep8_part1_fluid_compression_wave_speed [EXTRACTED 1.00]
- **Superposition, Interference & Standing Wave Normal Modes** — scpy130_ep8_part2_superposition_principle, scpy130_ep8_part2_constructive_destructive_interference, scpy130_ep8_part2_phase_shifted_superposition, scpy130_ep8_part2_standing_waves, scpy130_ep8_part2_nodes_and_antinodes, scpy130_ep8_part2_normal_modes_resonance, scpy130_ep8_part3_beats [INFERRED 0.85]
- **Moving-Source Doppler & Supersonic Shock Phenomena** — scpy130_ep8_part3_doppler_effect, scpy130_ep8_part3_doppler_shift_formula, scpy130_ep8_part3_train_car_doppler_example, scpy130_ep8_part3_bat_insect_echo_example, scpy130_ep8_part3_shock_waves, scpy130_ep8_part3_mach_number, scpy130_ep8_part3_cerenkov_radiation [INFERRED 0.85]
- **Hydrostatic Pressure and Pressure Measurement** — scpy130_ep9_part1_hydrostatic_equilibrium, scpy130_ep9_part1_pressure_at_depth, scpy130_ep9_part1_gauge_and_absolute_pressure, scpy130_ep9_part1_mercury_barometer, scpy130_ep9_part1_u_tube_manometer [EXTRACTED 1.00]
- **Ideal Fluid Dynamics and Bernoulli Flow** — scpy130_ep9_part2_ideal_fluid, scpy130_ep9_part2_volume_flow_rate, scpy130_ep9_part2_continuity_equation, scpy130_ep9_part2_bernoullis_equation, scpy130_ep9_part2_prandtl_pitot_tube [EXTRACTED 1.00]
- **Viscous Laminar Flow and Poiseuille Resistance** — scpy130_ep9_part2_viscosity, scpy130_ep9_part2_viscous_shear_force, scpy130_ep9_part2_pipe_velocity_profile, scpy130_ep9_part2_poiseuilles_law, scpy130_ep9_part2_flow_resistance [EXTRACTED 1.00]
- **Kinetic Theory and First Law Foundation** — scpy130_ep10_part1_ideal_gas_law, scpy130_ep10_part1_kinetic_energy_and_vrms, scpy130_ep10_part1_internal_energy_monatomic_gas, scpy130_ep10_part1_work_done_by_system, scpy130_ep10_part1_first_law_of_thermodynamics [EXTRACTED 1.00]
- **Four Fundamental Ideal-Gas Thermodynamic Processes** — scpy130_ep10_part2_isochoric_process, scpy130_ep10_part2_isobaric_process, scpy130_ep10_part2_isothermal_process, scpy130_ep10_part2_adiabatic_process [EXTRACTED 1.00]
- **Carnot Reversible Heat Engine Framework** — scpy130_ep10_part2_reversible_and_irreversible_processes, scpy130_ep10_part2_heat_engine, scpy130_ep10_part2_carnot_cycle, scpy130_ep10_part2_carnot_principle [EXTRACTED 1.00]

## Communities (6 total, 0 thin omitted)

### Community 0 - "Traveling Waves & Standing Interference"
Cohesion: 0.13
Nodes (24): Compression Wave Speed in a Fluid, Linear Mass Density (mu = m / L), Longitudinal Wave, Sinusoidal Periodic Wave Equation, Powerbuoy Renewable Wave Energy (Fig. 16.1), SCPY130 EP8 Part 1: Traveling Waves, Wave Speed on a Stretched String, Transverse Wave (+16 more)

### Community 1 - "Thermodynamics, Gas Laws & Heat Engines"
Cohesion: 0.15
Nodes (23): Boltzmann Constant k_B and Universal Gas Constant R, Closed (Isolated) vs. Open Thermodynamic Systems, First Law of Thermodynamics (Delta E_int = Q - W), Ideal Gas Law (pV = N k_B T = nRT), Internal Energy of Ideal Monatomic Gas (E_int = 3/2 nRT), Average Molecular Kinetic Energy & RMS Speed (v_rms), SCPY130 EP10 Part 1: First Law of Thermodynamics, p-V Diagram Path Dependence of Work (+15 more)

### Community 2 - "Oscillations, SHM & Resonance"
Cohesion: 0.23
Nodes (18): SCPY130 EP7 Part 1: Oscillations Slides, Comcast Building Tuned Liquid-Column Mass Damper, Hooke's Law Restoring Force and SHM Differential Equation, Mass-Spring Oscillator System, Period and Frequency Relationship, Physical Pendulum, SHM Position, Velocity, and Acceleration Equations, Simple Harmonic Motion (+10 more)

### Community 3 - "Hydrostatics, Pressure & Buoyancy"
Cohesion: 0.26
Nodes (14): SCPY130 EP9 Part 1: Fluids (Hydrostatics and Pascal's Principle), Mass Density (rho = m/V), Chapter 14: Fluid Mechanics, Absolute and Gauge Pressure (p_abs = p_g + p_atm), Hydraulic Lift and Brake System (F1/A1 = F2/A2), Hydrostatic Pressure Gradient (dp/dy = -rho g), Mercury Barometer, Pascal's Principle (+6 more)

### Community 4 - "Fluid Dynamics, Bernoulli & Viscosity"
Cohesion: 0.32
Nodes (14): SCPY130 EP9 Part 2: Fluids (Buoyancy, Fluid Dynamics and Viscosity), Bernoulli Suction Devices (Atomizer, Burner, Chimney), Bernoulli's Equation, Equation of Continuity (A1 v1 = A2 v2), Fire Hose Nozzle Pressure Analysis, Poiseuille Flow Resistance (R = 8 eta l / pi r^4), Ideal Fluid (Negligible Viscosity), Laminar vs. Turbulent Flow (+6 more)

### Community 5 - "Doppler Effect & Shock Waves"
Cohesion: 0.29
Nodes (8): Bat & Insect Double Doppler Echo Example, Cerenkov Radiation, The Doppler Effect (Sec. 17.7), General Doppler Shift Equation, Mach Number & Shock Cone Angle, Shock Waves & Mach Cone (Sec. 17.8), SCPY130 EP8 Part 3: Beats, Doppler Effect & Shock Waves, Train & Car Moving Source/Observer Example

## Knowledge Gaps
- **13 isolated node(s):** `Transverse Wave`, `Wave Pulse Propagation (Delta x = v Delta t)`, `Linear Mass Density (mu = m / L)`, `Mechanical Energy per Wavelength (E_lambda)`, `Nodes and Antinodes` (+8 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 13 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SCPY130 EP9 Part 1: Fluids (Hydrostatics and Pascal's Principle)` connect `Hydrostatics, Pressure & Buoyancy` to `Fluid Dynamics, Bernoulli & Viscosity`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `First Law of Thermodynamics (Delta E_int = Q - W)` (e.g. with `Thermodynamic System, Boundary & Surroundings` and `Heat Engine (W = Q_h - Q_c, Efficiency e = 1 - Q_c/Q_h)`) actually correct?**
  _`First Law of Thermodynamics (Delta E_int = Q - W)` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Transverse Wave`, `Wave Pulse Propagation (Delta x = v Delta t)`, `Linear Mass Density (mu = m / L)` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Traveling Waves & Standing Interference` be split into smaller, more focused modules?**
  _Cohesion score 0.13043478260869565 - nodes in this community are weakly interconnected._
- **Why does `The Doppler Effect (Sec. 17.7)` connect `Doppler Effect & Shock Waves` to `Traveling Waves & Standing Interference`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._