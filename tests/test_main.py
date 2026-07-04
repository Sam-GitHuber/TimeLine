"""
Testing module for main.py
"""
import pytest
from src.main import hello_world

def test_hello_world():
    """
    Simple test for hello world
    """
    result = hello_world()
    expected = True
    assert result == expected

if __name__ == '__main__':
    pytest.main()
