import torch
try:
    model = torch.load("models/best_model.pth", map_location='cpu')
    print("Type:", type(model))
    if isinstance(model, dict):
        print("Keys:", model.keys())
    print("Success loading best_model.pth")
except Exception as e:
    print("Error loading:", e)
