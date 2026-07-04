#!/bin/bash

# Extract the environment name from the YAML file
ENV_NAME=$(grep 'name: ' requirements.yml | cut -d ' ' -f2)

echo "Environment name extracted: $ENV_NAME"

# Check if the environment exists
if conda info --envs | grep -q "^${ENV_NAME} "; then
    echo "Environment '${ENV_NAME}' already exists. Deleting it..."
    conda env remove -n ${ENV_NAME}
    echo "Environment '${ENV_NAME}' has been removed."
fi

# Create the environment
echo "Creating the conda environment from requirements.yml..."
conda env create -f requirements.yml
echo "Environment '${ENV_NAME}' created successfully!"