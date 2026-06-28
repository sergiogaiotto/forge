---
name: pytorch-training
description: >-
  Build correct PyTorch training loops, Datasets/DataLoaders, mixed precision,
  checkpointing and reproducibility. Use whenever the user trains neural networks,
  writes PyTorch models, training loops, or works with torch tensors and DataLoaders.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
validators:
  - id: ruff
    label: ruff
    command: "ruff check {file}"
    gate: false
    appliesTo: [".py"]
---

# PyTorch Training

Author correct, reproducible PyTorch training code: data pipelines, the canonical
train/validation loop, device handling, automatic mixed precision (AMP), gradient
clipping, checkpointing, seeding, and early stopping.

## When to use

Use this skill whenever you:

- Write or review a PyTorch training/validation loop.
- Build a custom `Dataset` or configure a `DataLoader`.
- Add mixed precision (`torch.amp` / `torch.cuda.amp`), gradient clipping, or LR
  scheduling.
- Save or load checkpoints (model, optimizer, scheduler, epoch, RNG state).
- Need reproducible runs (seeding) or robust early stopping.
- Debug NaNs, OOM, "loss not decreasing", or device-mismatch errors during training.

Do not use it for pure inference-only serving concerns, deployment/quantization, or
non-PyTorch frameworks.

## Steps

1. **Set seeds first.** Seed `random`, `numpy`, and `torch` (CPU and CUDA) before
   creating models, optimizers, or DataLoaders. Use a `seed_worker` for DataLoader
   workers. Decide explicitly whether you need deterministic algorithms (slower) or
   just reproducible-enough behavior.
2. **Pick the device once.** `device = torch.device("cuda" if torch.cuda.is_available() else "cpu")`.
   Move the model with `model.to(device)` and move every batch with
   `x = x.to(device, non_blocking=True)` inside the loop.
3. **Build the data pipeline.** Implement a `Dataset` (`__len__`, `__getitem__`),
   then wrap it in `DataLoader` with `batch_size`, `shuffle=True` for train only,
   `num_workers`, and `pin_memory=True` when using CUDA.
4. **Create model, loss, optimizer, scheduler.** Instantiate the loss (e.g.
   `nn.CrossEntropyLoss()`), optimizer (e.g. `AdamW`), and optionally an LR scheduler.
   Create the AMP `GradScaler` if training on CUDA.
5. **Train one epoch.** Call `model.train()`. For each batch: move data to device,
   `optimizer.zero_grad(set_to_none=True)`, forward (inside `autocast` for AMP),
   compute loss, `scaler.scale(loss).backward()`, unscale, clip gradients, then
   `scaler.step(optimizer)` and `scaler.update()`. Accumulate the scalar loss via
   `loss.item()` — never keep the loss tensor.
6. **Validate.** Call `model.eval()` and wrap the loop in `torch.no_grad()` (or
   `torch.inference_mode()`). Compute validation loss/metrics without gradients.
7. **Step the scheduler and check early stopping.** Step the LR scheduler per epoch
   (or per step, depending on type). Track the best validation metric; save a
   checkpoint when it improves and stop if it has not improved for `patience` epochs.
8. **Checkpoint completely.** Save `model.state_dict()`, `optimizer.state_dict()`,
   scheduler/scaler state, epoch, and best metric so a run is fully resumable. Load
   with `map_location=device` and call `model.eval()` before inference.

## Examples

### 1. Clean train/validation loop with AMP, clipping, checkpointing and early stopping

```python
import random
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


def set_seed(seed: int = 42) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def run_epoch(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    device: torch.device,
    optimizer: torch.optim.Optimizer | None = None,
    scaler: torch.cuda.amp.GradScaler | None = None,
    max_grad_norm: float = 1.0,
) -> float:
    is_train = optimizer is not None
    model.train(is_train)

    total_loss = 0.0
    total_count = 0
    use_amp = scaler is not None and device.type == "cuda"

    # No gradient tracking during validation.
    grad_ctx = torch.enable_grad() if is_train else torch.no_grad()
    with grad_ctx:
        for inputs, targets in loader:
            inputs = inputs.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)

            if is_train:
                # Reset grads BEFORE backward; set_to_none is faster.
                optimizer.zero_grad(set_to_none=True)

            with torch.cuda.amp.autocast(enabled=use_amp):
                outputs = model(inputs)
                loss = criterion(outputs, targets)

            if is_train:
                if use_amp:
                    scaler.scale(loss).backward()
                    scaler.unscale_(optimizer)  # unscale before clipping
                    nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    loss.backward()
                    nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
                    optimizer.step()

            # Accumulate a Python float, NOT the loss tensor (avoids graph leak).
            batch_size = targets.size(0)
            total_loss += loss.item() * batch_size
            total_count += batch_size

    return total_loss / max(total_count, 1)


def train(
    model: nn.Module,
    train_loader: DataLoader,
    val_loader: DataLoader,
    *,
    epochs: int = 50,
    lr: float = 1e-3,
    patience: int = 5,
    ckpt_path: str = "best.pt",
) -> dict:
    set_seed(42)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    scaler = torch.cuda.amp.GradScaler(enabled=device.type == "cuda")

    best_val = float("inf")
    epochs_without_improve = 0

    for epoch in range(1, epochs + 1):
        train_loss = run_epoch(
            model, train_loader, criterion, device,
            optimizer=optimizer, scaler=scaler,
        )
        val_loss = run_epoch(model, val_loader, criterion, device)
        scheduler.step()

        print(f"epoch {epoch:03d} | train {train_loss:.4f} | val {val_loss:.4f}")

        if val_loss < best_val:
            best_val = val_loss
            epochs_without_improve = 0
            torch.save(
                {
                    "epoch": epoch,
                    "model_state": model.state_dict(),
                    "optimizer_state": optimizer.state_dict(),
                    "scheduler_state": scheduler.state_dict(),
                    "scaler_state": scaler.state_dict(),
                    "best_val": best_val,
                },
                ckpt_path,
            )
        else:
            epochs_without_improve += 1
            if epochs_without_improve >= patience:
                print(f"early stopping at epoch {epoch} (best val {best_val:.4f})")
                break

    return {"best_val": best_val, "ckpt_path": ckpt_path}


def load_checkpoint(model: nn.Module, ckpt_path: str, device: torch.device) -> dict:
    ckpt = torch.load(ckpt_path, map_location=device)
    model.load_state_dict(ckpt["model_state"])
    model.to(device)
    model.eval()  # switch to eval before inference
    return ckpt


if __name__ == "__main__":
    # Minimal runnable smoke test on synthetic data.
    set_seed(0)
    x = torch.randn(512, 20)
    y = torch.randint(0, 3, (512,))
    train_ds = TensorDataset(x[:400], y[:400])
    val_ds = TensorDataset(x[400:], y[400:])

    use_cuda = torch.cuda.is_available()
    train_loader = DataLoader(
        train_ds, batch_size=32, shuffle=True,
        num_workers=2, pin_memory=use_cuda,
    )
    val_loader = DataLoader(
        val_ds, batch_size=64, shuffle=False,
        num_workers=2, pin_memory=use_cuda,
    )

    net = nn.Sequential(nn.Linear(20, 64), nn.ReLU(), nn.Linear(64, 3))
    result = train(net, train_loader, val_loader, epochs=10, patience=3)
    print(result)
    Path(result["ckpt_path"]).exists()
```

### 2. Custom `Dataset` with a reproducible `DataLoader`

```python
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset


class ImageCsvDataset(Dataset):
    """Loads (image, label) pairs listed in a CSV: `relative_path,label`."""

    def __init__(self, root: str | Path, csv_file: str | Path, transform=None):
        self.root = Path(root)
        self.transform = transform
        self.samples: list[tuple[Path, int]] = []

        with open(csv_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rel_path, label = line.split(",")
                self.samples.append((self.root / rel_path, int(label)))

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, int]:
        path, label = self.samples[idx]
        # Open inside __getitem__ so each worker reads its own file handle.
        with Image.open(path) as img:
            img = img.convert("RGB")
            if self.transform is not None:
                tensor = self.transform(img)
            else:
                arr = np.asarray(img, dtype=np.float32) / 255.0
                tensor = torch.from_numpy(arr).permute(2, 0, 1).contiguous()
        return tensor, label


def seed_worker(worker_id: int) -> None:
    # Each worker derives a distinct, reproducible seed from torch's base seed.
    worker_seed = torch.initial_seed() % 2**32
    np.random.seed(worker_seed)
    random.seed(worker_seed)


def make_loader(dataset: Dataset, *, batch_size: int, train: bool, seed: int = 42):
    generator = torch.Generator()
    generator.manual_seed(seed)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=train,
        num_workers=4,
        pin_memory=torch.cuda.is_available(),
        drop_last=train,
        worker_init_fn=seed_worker,
        generator=generator,
    )


if __name__ == "__main__":
    ds = ImageCsvDataset(root="data/images", csv_file="data/train.csv")
    loader = make_loader(ds, batch_size=32, train=True)
    images, labels = next(iter(loader))
    print(images.shape, labels.shape)  # e.g. torch.Size([32, 3, H, W]) torch.Size([32])
```

## Common errors

- **Forgetting `optimizer.zero_grad()`.** Gradients accumulate across batches by
  default, so omitting `zero_grad(set_to_none=True)` before `backward()` silently
  corrupts updates. Zero before each backward pass, not after.
- **Wrong train/eval mode.** Not calling `model.train()` / `model.eval()` leaves
  Dropout and BatchNorm in the wrong state, producing unstable training or
  misleading validation metrics. Set the mode explicitly each phase.
- **Accumulating the graph via the loss tensor.** Writing `running_loss += loss`
  keeps the entire autograd graph alive, leaking memory until OOM. Detach to a
  Python number with `loss.item()` (or `loss.detach()`).
- **Missing `torch.no_grad()` in validation.** Running eval without
  `torch.no_grad()` / `torch.inference_mode()` builds graphs and wastes memory; it
  can also turn an evaluation pass into an accidental OOM on large models.
- **Data and model on different devices.** Forgetting `.to(device)` on the batch (or
  on the model) raises `Expected all tensors to be on the same device`. Move both,
  and use `non_blocking=True` with `pin_memory=True` for CUDA throughput.
- **Clipping scaled gradients under AMP.** With `GradScaler` you must call
  `scaler.unscale_(optimizer)` before `clip_grad_norm_`, otherwise you clip scaled
  gradients and get wrong norms.
- **Non-resumable checkpoints.** Saving only `model.state_dict()` loses optimizer,
  scheduler, scaler, and epoch state — resumed runs diverge. Save and restore all of
  them, and load with `map_location=device`.
- **Shuffling validation or shuffling with non-reproducible workers.** Use
  `shuffle=True` for train only, and set `worker_init_fn` plus a seeded `generator`
  so runs are reproducible across workers.
- **Calling `optimizer.step()` before `backward()`** or stepping the scheduler at the
  wrong cadence (per-step schedulers stepped per-epoch, or vice versa) — verify the
  scheduler's expected stepping frequency.
```
