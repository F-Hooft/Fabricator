import openmm as mm
from openmm import app,  unit
from sys import stdout


pdb = app.PDBFile('water_2500.pdb')
forcefield = app.ForceField('tip3p.xml')
temp = 293.15 * unit.kelvin

temp = 200 * unit.kelvin

# temp = 500 * unit.kelvin

system = forcefield.createSystem(
    pdb.topology,
    nonbondedMethod=app.PME,
    nonbondedCutoff=1.0*unit.nanometer,
    constraints=app.HBonds
)

barostat = mm.MonteCarloBarostat(1*unit.atmosphere, temp, 25)
#system.addForce(barostat)

integrator = mm.LangevinMiddleIntegrator(temp, 1.0/unit.picosecond, 1*unit.femtosecond)
simulation = app.Simulation(pdb.topology, system, integrator, platform=mm.Platform.getPlatformByName('CUDA'))

simulation.context.setPositions(pdb.positions)
simulation.minimizeEnergy()
simulation.context.setVelocitiesToTemperature(temp)
simulation.reporters.append(app.DCDReporter('NEU_1000_simulation.dcd', 1000))
simulation.reporters.append(app.StateDataReporter(stdout, 1000, step=True, potentialEnergy=True, temperature=True, density=True, speed=True))

simulation.step(10000)

temp = 7200 * unit.kelvin

